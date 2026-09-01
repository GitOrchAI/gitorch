import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { cascataRoutes } from './cascata.js'

/**
 * A CASCATA É DO CLIENTE. Ela mora em `Project.runtimeConfig.agents`, por
 * projeto, e nunca numa configuração global — errar isso vaza a escolha de um
 * cliente para outro.
 */
describe('Rotas da cascata por agente', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  const CATALOGOS: Record<string, string[]> = {
    antigravity: [
      'Gemini 3.7 Flash (High)',
      'Gemini 3.7 Flash (Medium)',
      'Gemini 3.1 Pro (High)',
      'Claude Opus 4.6 (Thinking)',
    ],
    claude: ['Claude Opus 5', 'Claude Sonnet 5', 'Claude Haiku 4.5'],
    codex: ['GPT-5.5', 'GPT-5.4-Mini', 'Codex Auto Review'],
  }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await cascataRoutes(app)

    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }

    app.prisma.project.findFirst = vi
      .fn()
      .mockResolvedValue({ id: 'proj_1', userId: 'user_123', runtimeConfig: null })
    app.prisma.project.update = vi.fn(async (args: unknown) => ({
      id: 'proj_1',
      runtimeConfig: (args as { data: { runtimeConfig: unknown } }).data.runtimeConfig,
    }))
    app.prisma.engineConnection.findMany = vi.fn().mockResolvedValue(
      Object.entries(CATALOGOS).map(([runtime, models]) => ({
        runtime,
        models,
        modelsUnavailable: [],
        status: 'connected',
      }))
    )

    await app.ready()
  })

  describe('GET das opções: elas saem do CATÁLOGO, nunca de lista escrita na mão', () => {
    test('cada motor devolve os modelos dele e a escada de esforço dele', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata/opcoes',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        motores: Array<{
          runtime: string
          esforcos: string[]
          esforcoNoNomeDoModelo: boolean
          modelos: Array<{ valor: string; rotulo: string }>
        }>
      }

      const claude = body.motores.find((m) => m.runtime === 'claude')
      // A tela mostra o nome de vitrine; o que é GRAVADO e vai para o CLI é o
      // identificador. `claude --model "Claude Opus 5"` é recusado ao vivo.
      expect(claude?.modelos).toContainEqual({ valor: 'claude-opus-5', rotulo: 'Claude Opus 5' })
      expect(claude?.esforcos).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(claude?.esforcoNoNomeDoModelo).toBe(false)

      const codex = body.motores.find((m) => m.runtime === 'codex')
      expect(codex?.esforcos).toEqual(['low', 'medium', 'high', 'xhigh'])

      const agy = body.motores.find((m) => m.runtime === 'antigravity')
      // No Antigravity o esforço não é escolha separada — a tela precisa saber
      // disso para não oferecer um seletor que o motor recusa.
      expect(agy?.esforcoNoNomeDoModelo).toBe(true)
      expect(agy?.modelos).toContainEqual({
        valor: 'Gemini 3.1 Pro (High)',
        rotulo: 'Gemini 3.1 Pro (High)',
      })
    })

    /**
     * O MODELO QUE SAIU DO AR PRECISA APARECER DIZENDO QUE SAIU.
     *
     * A coleta não apaga o modelo removido pelo provedor: marca em
     * `models_unavailable` com a data (PR de 31/08). Só que as opções da tela
     * liam apenas `models` — então o modelo morto simplesmente SUMIA da lista.
     *
     * O efeito na tela é pior do que parece: um `<select>` cujo `value` não
     * está entre as `<option>` mostra a PRIMEIRA opção. O dono abriria a
     * cascata que ele mesmo montou e leria um modelo que nunca escolheu, sem
     * um aviso — e salvar por cima trocaria a escolha dele em silêncio. É a
     * mesma família do defeito de 31/08 (o produto sabia e não contava),
     * agora na cara do cliente.
     */
    test('modelo marcado como indisponível pela coleta VEM na resposta, com a data', async () => {
      app.prisma.engineConnection.findMany = vi.fn().mockResolvedValue([
        {
          runtime: 'antigravity',
          models: ['Gemini 3.7 Flash (High)'],
          modelsUnavailable: [
            { nome: 'Gemini 3.5 Flash (Medium)', sumiuEm: '2026-08-31T23:00:00.000Z' },
          ],
          status: 'connected',
        },
      ])

      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata/opcoes',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      const agy = (
        res.json() as {
          motores: Array<{
            runtime: string
            modelos: Array<{ valor: string; rotulo: string }>
            indisponiveis: Array<{ valor: string; rotulo: string; sumiuEm: string | null }>
          }>
        }
      ).motores.find((m) => m.runtime === 'antigravity')

      // O que está vivo continua vivo, e separado do que morreu: misturar os
      // dois numa lista só devolveria o modelo morto como opção legítima.
      expect(agy?.modelos).toEqual([
        { valor: 'Gemini 3.7 Flash (High)', rotulo: 'Gemini 3.7 Flash (High)' },
      ])
      expect(agy?.indisponiveis).toEqual([
        {
          valor: 'Gemini 3.5 Flash (Medium)',
          rotulo: 'Gemini 3.5 Flash (Medium)',
          sumiuEm: '2026-08-31T23:00:00.000Z',
        },
      ])
    })

    test('o valor do indisponível também é convertido para o que o CLI aceita', async () => {
      // Mesma armadilha do catálogo vivo: o claude guarda nome de vitrine
      // ("Claude Opus 5") e o CLI só aceita o identificador. Um indisponível
      // convertido de um jeito e o catálogo de outro nunca casariam na tela, e
      // o modelo gravado apareceria DUAS vezes — uma como escolha, outra como
      // "saiu do ar".
      app.prisma.engineConnection.findMany = vi.fn().mockResolvedValue([
        {
          runtime: 'claude',
          models: ['Claude Sonnet 5'],
          modelsUnavailable: [{ nome: 'Claude Opus 4.1', sumiuEm: null }],
          status: 'connected',
        },
      ])
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata/opcoes',
        headers: authHeaders,
      })
      const claude = (
        res.json() as {
          motores: Array<{
            runtime: string
            indisponiveis: Array<{ valor: string; rotulo: string; sumiuEm: string | null }>
          }>
        }
      ).motores.find((m) => m.runtime === 'claude')
      expect(claude?.indisponiveis).toEqual([
        { valor: 'claude-opus-4-1', rotulo: 'Claude Opus 4.1', sumiuEm: null },
      ])
    })

    test('motor sem nada marcado devolve lista vazia, nunca ausente', async () => {
      // `undefined` obrigaria toda a tela a testar antes de percorrer, e uma
      // tela que esquece o teste quebra no cliente. Contrato: sempre array.
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata/opcoes',
        headers: authHeaders,
      })
      for (const motor of (res.json() as { motores: Array<{ indisponiveis: unknown }> }).motores) {
        expect(motor.indisponiveis).toEqual([])
      }
    })

    test('as opções são as do DONO do projeto, não uma lista global', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata/opcoes',
        headers: authHeaders,
      })
      const where = (app.prisma.engineConnection.findMany as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.where
      expect(where?.userId).toBe('user_123')
    })
  })

  describe('GET da cascata', () => {
    test('projeto que nunca escolheu recebe o PADRÃO, marcado como padrão', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        escolhida: boolean
        agents: Record<string, { runtime: string; model?: string; effort?: string }>
      }
      expect(body.escolhida).toBe(false)
      // O motor padrão de cada papel é o do pacote de agentes (hoje `codex`
      // para os quatro) — a rota lê a MESMA fonte que o scheduler, sem uma
      // segunda lista para divergir.
      expect(body.agents['qa']?.runtime).toBe('codex')
      // O QA julga: modelo forte, esforço alto. O SM só movimenta: o barato.
      // É a exigência declarada em services/padrao-do-degrau.ts — e é a
      // diferença que não existia, com ra/sm/qa todos no mesmo modelo.
      // E o modelo já sai no identificador que o CLI aceita: `codex exec -m
      // "GPT-5.5"` é recusado pelo provedor, `-m gpt-5.5` passa.
      expect(body.agents['qa']?.model).toBe('gpt-5.5')
      expect(body.agents['qa']?.effort).toBe('high')
      expect(body.agents['sm']?.model).toBe('gpt-5.4-mini')
      expect(body.agents['sm']?.effort).toBe('low')
      expect(body.agents['po']?.effort).toBe('high')
      expect(body.agents['ra']?.effort).toBe('medium')
    })

    test('projeto que escolheu recebe a escolha dele, intacta', async () => {
      app.prisma.project.findFirst = vi.fn().mockResolvedValue({
        id: 'proj_1',
        userId: 'user_123',
        runtimeConfig: {
          agents: {
            qa: {
              runtime: 'antigravity',
              model: 'Gemini 3.1 Pro (High)',
              fallbacks: [{ runtime: 'claude', model: 'Claude Haiku 4.5', effort: 'xhigh' }],
            },
          },
        },
      })
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
      })
      const body = res.json() as {
        escolhida: boolean
        agents: Record<string, { runtime: string; model?: string; fallbacks?: unknown[] }>
      }
      expect(body.escolhida).toBe(true)
      expect(body.agents['qa']).toEqual({
        runtime: 'antigravity',
        model: 'Gemini 3.1 Pro (High)',
        fallbacks: [{ runtime: 'claude', model: 'Claude Haiku 4.5', effort: 'xhigh' }],
      })
    })

    test('projeto de outro dono é 404, não a cascata alheia', async () => {
      app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/proj_de_outro/cascata',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('PUT da cascata', () => {
    test('grava a cascata do dono e PRESERVA o resto do runtimeConfig', async () => {
      app.prisma.project.findFirst = vi.fn().mockResolvedValue({
        id: 'proj_1',
        userId: 'user_123',
        runtimeConfig: { board: { sprintDays: 14 }, agents: { po: { runtime: 'codex' } } },
      })
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: {
          agents: {
            qa: {
              runtime: 'antigravity',
              model: 'Gemini 3.1 Pro (High)',
              fallbacks: [
                { runtime: 'claude', model: 'Claude Haiku 4.5', effort: 'xhigh' },
                { runtime: 'codex', model: 'GPT-5.5', effort: 'high' },
              ],
            },
          },
        },
      })
      expect(res.statusCode).toBe(200)
      const gravado = (app.prisma.project.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.data?.runtimeConfig as Record<string, unknown>
      // O quadro do projeto não pode ser apagado por uma gravação de cascata.
      expect(gravado['board']).toEqual({ sprintDays: 14 })
      // E a cascata inteira é substituída — inclusive apagando o po antigo,
      // porque a tela manda o estado completo dos quatro papéis.
      expect(gravado['agents']).toEqual({
        qa: {
          runtime: 'antigravity',
          model: 'Gemini 3.1 Pro (High)',
          fallbacks: [
            { runtime: 'claude', model: 'Claude Haiku 4.5', effort: 'xhigh' },
            { runtime: 'codex', model: 'GPT-5.5', effort: 'high' },
          ],
        },
      })
    })

    test('a gravação é escopada ao projeto do dono — nunca por id solto', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: { agents: { sm: { runtime: 'codex' } } },
      })
      const where = (app.prisma.project.findFirst as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.where
      expect(where?.id).toBe('proj_1')
    })

    test('motor inventado é recusado na porta', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: { agents: { qa: { runtime: 'gemini-pirata' } } },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/gemini-pirata/)
      expect(app.prisma.project.update).not.toHaveBeenCalled()
    })

    test('papel inventado é recusado na porta', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: { agents: { arquiteto: { runtime: 'codex' } } },
      })
      expect(res.statusCode).toBe(400)
      expect(app.prisma.project.update).not.toHaveBeenCalled()
    })

    test("esforço que o motor não tem é recusado: 'max' no codex", async () => {
      // 'max' existe no claude e não no codex. Aceitar aqui seria mandar um
      // nível inválido para a API do provedor — e no claude, que só AVISA e
      // roda no padrão, o cliente pagaria por um esforço nunca aplicado.
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: { agents: { qa: { runtime: 'codex', model: 'GPT-5.5', effort: 'max' } } },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/max/)
      expect(app.prisma.project.update).not.toHaveBeenCalled()
    })

    test("o mesmo 'max' passa quando o motor é o claude", async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: { agents: { qa: { runtime: 'claude', model: 'Claude Opus 5', effort: 'max' } } },
      })
      expect(res.statusCode).toBe(200)
    })

    test('esforço no antigravity é recusado: lá ele vive dentro do nome do modelo', async () => {
      // `agy --model X --effort high` é erro duro do CLI (medido ao vivo).
      // Aceitar a escolha e depois ignorá-la em silêncio seria mentir para o
      // dono na tela.
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: {
          agents: {
            qa: { runtime: 'antigravity', model: 'Gemini 3.1 Pro (High)', effort: 'high' },
          },
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/antigravity/)
    })

    test('modelo fora do catálogo vivo não bloqueia, mas volta como AVISO', async () => {
      // Bloquear seria trocar desperdício por paralisação: o catálogo pode
      // estar vazio (coleta nunca rodou) ou atrasado. Mas calar seria repetir
      // 31/08 — o cliente escolheria um modelo morto sem saber.
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: {
          agents: { qa: { runtime: 'claude', model: 'Claude Opus 3', effort: 'high' } },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().avisos.join(' ')).toMatch(/Claude Opus 3/)
    })

    test('degrau com só o motor continua válido — a mudança é ADITIVA', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/projects/proj_1/cascata',
        headers: authHeaders,
        payload: { agents: { ra: { runtime: 'codex', fallbacks: [{ runtime: 'claude' }] } } },
      })
      expect(res.statusCode).toBe(200)
      const gravado = (app.prisma.project.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.data?.runtimeConfig as { agents: unknown }
      expect(gravado.agents).toEqual({
        ra: { runtime: 'codex', fallbacks: [{ runtime: 'claude' }] },
      })
    })
  })
})
