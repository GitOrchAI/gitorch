import { describe, expect, test, vi } from 'vitest'
import {
  modeloVivoParaAMissao,
  degrausQueValemATentativa,
  varrerCatalogoDeModelosDoRelogio,
} from './scheduler.js'
import { resolveRuntimeChain, type ResolverDefaults } from '../lib/runtime-resolver.js'

/**
 * O PONTO DE LIGAÇÃO entre o catálogo COLETADO e a escolha do modelo da missão.
 *
 * As peças puras estão testadas caso a caso (catalogo-vivo-de-modelos.test.ts,
 * modelos-a-recoletar.test.ts, scheduler-modelo-vivo.test.ts). Aqui prova-se o
 * que só a LIGAÇÃO pode errar: a cadeia que o resolvedor REAL produz, passada
 * pela conferência REAL contra os catálogos REAIS do banco, resulta nos degraus
 * certos. Nada aqui imita o laço do failover — são as mesmas funções que
 * `executeMissionWithFailover` chama, na mesma ordem.
 */

// Os padrões REAIS do scheduler (MODEL_BY_ROLE / RESOLVER_DEFAULTS): motor
// padrão codex para todo papel, e um modelo do ANTIGRAVITY como modelo padrão
// de qualquer motor. É essa segunda parte que envenena os degraus dos outros
// motores, e ninguém tinha medido.
const PADROES_REAIS: ResolverDefaults = {
  runtimeByRole: { po: 'codex', ra: 'codex', sm: 'codex', qa: 'codex' },
  modelByRole: {
    po: 'Gemini 3.1 Pro (Low)',
    ra: 'Gemini 3.7 Flash (Medium)',
    sm: 'Gemini 3.7 Flash (Medium)',
    qa: 'Gemini 3.7 Flash (Medium)',
  },
}

// OS CATÁLOGOS REAIS, copiados do banco de produção em 01/09/2026 03:00:
//   select runtime, models from engine_connections where runtime <> 'github'
const CATALOGO_DO_BANCO: Record<string, string[]> = {
  antigravity: [
    'Gemini 3.7 Flash (High)',
    'Gemini 3.7 Flash (Medium)',
    'Gemini 3.7 Flash (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (Low)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ],
  claude: [
    'Claude Opus 5',
    'Claude Sonnet 5',
    'Claude Fable 5',
    'Claude Opus 4.8',
    'Claude Opus 4.7',
    'Claude Sonnet 4.6',
    'Claude Opus 4.6',
    'Claude Opus 4.5',
    'Claude Haiku 4.5',
    'Claude Sonnet 4.5',
  ],
  codex: ['GPT-5.5', 'GPT-5.4-Mini', 'Codex Auto Review'],
}

const prismaComOsCatalogosReais = (catalogos = CATALOGO_DO_BANCO) => ({
  engineConnection: {
    findFirst: vi.fn(async (args: unknown) => {
      const runtime = (args as { where: { runtime: string } }).where.runtime
      const models = catalogos[runtime]
      return models ? { models } : null
    }),
  },
})

const semLog = { warn: (): void => undefined }

/** Exatamente a sequência de `executeMissionWithFailover`, com as funções reais. */
async function degrausDaMissao(args: {
  role: 'po' | 'ra' | 'sm' | 'qa'
  motoresConectados: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any
  log?: { warn: (msg: string) => void }
}) {
  const cadeia = resolveRuntimeChain(args.role, null, PADROES_REAIS, args.motoresConectados)
  const conferidos = await Promise.all(
    cadeia.map(async (sel) => ({
      runtime: sel.runtime,
      ...(await modeloVivoParaAMissao({
        prisma: args.prisma,
        ownerUserId: 'user_1',
        runtime: sel.runtime,
        desejado: sel.model ?? PADROES_REAIS.modelByRole[args.role],
        log: args.log ?? semLog,
      })),
    }))
  )
  return degrausQueValemATentativa(conferidos)
}

describe('o catálogo coletado LIGADO à escolha do modelo (caminho real da missão)', () => {
  test('o resolvedor real entrega o modelo do Antigravity aos TRÊS motores — este é o estado de hoje', () => {
    // Isto não é hipótese: é a saída de `resolveRuntimeChain` com os padrões
    // reais do scheduler. E `claude --model "Gemini 3.7 Flash (Medium)"`,
    // rodado ao vivo nesta VM em 01/09/2026 com a credencial do dono,
    // responde: "There's an issue with the selected model (Gemini 3.7 Flash
    // (Medium)). It may not exist or you may not have access to it."
    // Ou seja: o degrau do claude do rodízio era um container queimado.
    const cadeia = resolveRuntimeChain('ra', null, PADROES_REAIS, [
      'antigravity',
      'claude',
      'codex',
    ])
    expect(cadeia).toEqual([
      { runtime: 'codex', model: 'Gemini 3.7 Flash (Medium)' },
      { runtime: 'antigravity', model: 'Gemini 3.7 Flash (Medium)' },
      { runtime: 'claude', model: 'Gemini 3.7 Flash (Medium)' },
    ])
  })

  test('com o catálogo ligado, NENHUM degrau é perdido e cada motor recebe o que ele entende', async () => {
    const r = await degrausDaMissao({
      role: 'ra',
      motoresConectados: ['antigravity', 'claude', 'codex'],
      prisma: prismaComOsCatalogosReais(),
    })
    expect(r.pulados).toEqual([])
    expect(r.degraus).toEqual([
      // codex e claude não conhecem modelo Gemini nenhum: rodam com o modelo
      // padrão deles em vez de morrer pedindo um que não existe lá.
      { runtime: 'codex', modelo: undefined, valeATentativa: true },
      { runtime: 'antigravity', modelo: 'Gemini 3.7 Flash (Medium)', valeATentativa: true },
      { runtime: 'claude', modelo: undefined, valeATentativa: true },
    ])
  })

  test('O DEFEITO DE 31/08: o modelo removido pelo provedor não queima mais a rodada', async () => {
    // O catálogo do antigravity coletado DEPOIS da remoção (a saída real de
    // `agy models` nesta VM em 01/09: 11 modelos, nenhum 3.5) e um projeto que
    // escolheu explicitamente um esforço que não existe mais nessa família.
    // Antes: a missão pagava um `podman run` para receber `invalid model
    // selection` — 24 vezes em 9h48. Agora o degrau é PULADO e o seguinte
    // assume.
    const semA35 = {
      ...CATALOGO_DO_BANCO,
      antigravity: CATALOGO_DO_BANCO['antigravity']?.filter((m) => !m.includes('3.5')) ?? [],
    }
    const avisos: string[] = []
    const cadeia = [
      { runtime: 'antigravity', model: 'Gemini 3.5 Flash (Turbo)' },
      { runtime: 'claude' },
    ]
    const conferidos = await Promise.all(
      cadeia.map(async (sel) => ({
        runtime: sel.runtime,
        ...(await modeloVivoParaAMissao({
          prisma: prismaComOsCatalogosReais(semA35),
          ownerUserId: 'user_1',
          runtime: sel.runtime,
          desejado: sel.model ?? PADROES_REAIS.modelByRole['ra'],
          log: { warn: (m: string) => avisos.push(m) },
        })),
      }))
    )
    const r = degrausQueValemATentativa(conferidos)

    expect(r.pulados.map((d) => d.runtime)).toEqual(['antigravity'])
    expect(r.degraus.map((d) => d.runtime)).toEqual(['claude'])
    // E DIZ POR QUÊ, com o nome do modelo e do motor: o defeito original durou
    // 9h48 porque ninguém foi avisado de nada.
    const sobreOAntigravity = avisos.find((a) => a.includes('antigravity'))
    expect(sobreOAntigravity).toContain('Gemini 3.5 Flash (Turbo)')
  })

  test('FAIL-OPEN de ponta a ponta: banco fora do ar não pula degrau nenhum', async () => {
    const r = await degrausDaMissao({
      role: 'ra',
      motoresConectados: ['antigravity', 'claude'],
      prisma: {
        engineConnection: { findFirst: vi.fn().mockRejectedValue(new Error('sem banco')) },
      },
    })
    expect(r.pulados).toEqual([])
    // Três degraus: o codex padrão do papel mais os dois motores conectados.
    // TODOS seguem com o modelo pedido — sem catálogo, a resposta honesta é
    // "não sei", nunca "o modelo não existe".
    expect(r.degraus.map((d) => d.runtime)).toEqual(['codex', 'antigravity', 'claude'])
    expect(r.degraus.every((d) => d.modelo === 'Gemini 3.7 Flash (Medium)')).toBe(true)
  })
})

describe('varrerCatalogoDeModelosDoRelogio — a coleta pelo relógio, ligada de verdade', () => {
  const fakeApp = (
    conexoes: Array<Record<string, unknown>>,
    refreshModels = vi.fn(async () => ['GPT-5.5'])
  ) =>
    ({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      prisma: { engineConnection: { findMany: vi.fn(async () => conexoes) } },
      engineConnections: { refreshModels },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

  test('coleta a conexão vencida e NÃO toca na que está em dia nem na que está caída', async () => {
    const refreshModels = vi.fn(async () => ['GPT-5.5'])
    const app = fakeApp(
      [
        { userId: 'u1', runtime: 'antigravity', status: 'connected', modelsCheckedAt: null },
        {
          userId: 'u1',
          runtime: 'claude',
          status: 'connected',
          modelsCheckedAt: new Date(Date.now() - 60_000),
        },
        { userId: 'u1', runtime: 'codex', status: 'needs_reconnect', modelsCheckedAt: null },
      ],
      refreshModels
    )
    await varrerCatalogoDeModelosDoRelogio(app)
    expect(refreshModels.mock.calls).toEqual([['u1', 'antigravity']])
  })

  test('uma conexão que explode não impede a seguinte de ser coletada', async () => {
    const refreshModels = vi.fn(async (_userId: string, runtime: string) => {
      if (runtime === 'antigravity') throw new Error('binário fora do ar')
      return ['Claude Opus 5']
    })
    const app = fakeApp(
      [
        { userId: 'u1', runtime: 'antigravity', status: 'connected', modelsCheckedAt: null },
        { userId: 'u1', runtime: 'claude', status: 'connected', modelsCheckedAt: null },
      ],
      refreshModels as never
    )
    await expect(varrerCatalogoDeModelosDoRelogio(app)).resolves.toBeUndefined()
    expect(refreshModels.mock.calls.map((c) => c[1])).toEqual(['antigravity', 'claude'])
  })

  test('catálogo vazio não é silêncio: o dono fica sabendo que a lista está velha', async () => {
    const app = fakeApp(
      [{ userId: 'u1', runtime: 'antigravity', status: 'connected', modelsCheckedAt: null }],
      vi.fn(async () => [])
    )
    await varrerCatalogoDeModelosDoRelogio(app)
    expect(app.log.warn.mock.calls[0]?.[0]).toContain('preservada')
  })

  test('sem conexão vencida, nem chega a chamar a coleta', async () => {
    const refreshModels = vi.fn(async () => ['GPT-5.5'])
    const app = fakeApp(
      [
        {
          userId: 'u1',
          runtime: 'antigravity',
          status: 'connected',
          modelsCheckedAt: new Date(),
        },
      ],
      refreshModels
    )
    await varrerCatalogoDeModelosDoRelogio(app)
    expect(refreshModels).not.toHaveBeenCalled()
  })
})
