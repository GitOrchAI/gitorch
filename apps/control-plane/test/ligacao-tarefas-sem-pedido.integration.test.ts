import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { varrerRetratoDoProjeto } from '../src/services/varredura-do-retrato.js'
import { atualizarFichaDoItem, type PrismaDaFichaDoItem } from '../src/services/ficha-do-item.js'
import {
  criarLeitorDoQuadro,
  montarConferenciaDoRetrato,
} from '../src/services/conferencia-no-retrato.js'
import {
  desfazerAjusteDaTarefaDoProjeto,
  rodarAjusteDoPoComPrisma,
  TETO_DE_AJUSTES_POR_MISSAO,
} from '../src/services/ajuste-de-tarefas-do-po.js'
import { registrarForaDaSprintComPrisma } from '../src/services/reavaliar-fora-da-sprint-no-painel.js'
import { limparCacheDeLeituraDoQuadro } from '../src/services/leitura-do-quadro-em-cache.js'
import { fetchDoRepositorio } from '../src/services/guarda-de-autonomia.js'
import { limparFreiosDeCota } from '../src/services/freio-de-cota-do-github.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui.
vi.unmock('@prisma/client')

/**
 * Tarefas sem pedido, de ponta a ponta, contra o banco real e um GitHub de
 * mentira num servidor HTTP local (issues, PATCH e o quadro em GraphQL):
 *
 *  4.1 a varredura confere cada tarefa e grava em `repo_items.conferencia`,
 *      sem tocar em `estado`, e a segunda passada não muda nada;
 *  4.2 a missão do PO reescreve (no máximo 3), guarda o original, registra no
 *      painel e dá para desfazer; nada é escrito sem autonomia "cuidar", com
 *      sessão do dev viva, entrega em julgamento ou edição humana recente;
 *  4.3 a tarefa fora da sprint vira só um evento de painel, sem chamada nova.
 */
const controlPlaneDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(controlPlaneDir, 'scripts', 'db-migrate.sh')
const adminUrl = process.env['GITORCH_TEST_DATABASE_URL']

function canConnect(url: string): boolean {
  try {
    execFileSync('psql', [url, '-tAc', 'SELECT 1'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const reachable = Boolean(adminUrl) && canConnect(adminUrl as string)

if (Boolean(process.env['CI']) && !reachable) {
  throw new Error('GITORCH_TEST_DATABASE_URL inalcançável em CI')
}

function requireAdminUrl(): string {
  if (!adminUrl) throw new Error('GITORCH_TEST_DATABASE_URL ausente')
  return adminUrl
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${dbName}`
  return parsed.toString()
}

function psql(url: string, sql: string): string {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], {
    encoding: 'utf-8',
  }).trim()
}

function applySchema(dbUrl: string): void {
  const result = spawnSync('bash', [scriptPath], {
    cwd: controlPlaneDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`scripts/db-migrate.sh falhou:\n${result.stdout}\n${result.stderr}`)
  }
}

const REPO = 'o/r'
const HORA = 3_600_000

const CORPO_NO_PADRAO = [
  '## Goal',
  'g',
  '## Task Details',
  'd',
  '## Task Description',
  'd',
  '## Implementation Guide',
  'i com passo concreto',
  '## Verification Criteria',
  'rodar `pnpm test` e ver 0 falhas',
  '## Dependencies',
  'nenhuma',
  '## Related Files',
  'src/x.ts',
  '## Notes',
  'n',
  '## Peso',
  '**3**',
].join('\n\n')

interface IssueFalsa {
  number: number
  title: string
  body: string | null
  labels: string[]
  state: 'open' | 'closed'
  updatedAt: Date
}

interface ItemDoQuadroFalso {
  pedido: number
  iteracaoId: string | null
  peso: number | null
}

function issue(numero: number, extra: Partial<IssueFalsa> = {}): IssueFalsa {
  return {
    number: numero,
    title: `Tarefa ${numero}`,
    body: `Texto solto da tarefa ${numero}. Veja #${numero + 1000} e https://exemplo.com/t/${numero}.`,
    labels: ['gitorch:task'],
    state: 'open',
    updatedAt: new Date(Date.now() - 72 * HORA),
    ...extra,
  }
}

/** O GitHub de mentira: issues, PATCH e o quadro (GraphQL). Conta tudo o que chega. */
function githubLocal(config: { issues: IssueFalsa[]; quadro: ItemDoQuadroFalso[] }) {
  const requisicoes: string[] = []
  const escritas: Array<{ numero: number; title?: string; body?: string }> = []
  const graphql: string[] = []
  const issues = new Map(config.issues.map((i) => [i.number, i]))
  /** `respostaDoPatchComErro`: o PATCH é aplicado no servidor, mas o cliente recebe 500. */
  const controle = { respostaDoPatchComErro: false }

  const emJson = (i: IssueFalsa) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    updated_at: i.updatedAt.toISOString(),
  })

  const servidor: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    const fluxo: NodeJS.EventEmitter = req
    fluxo.on('data', (c: Buffer) => chunks.push(c))
    fluxo.on('end', () => {
      const caminho = req.url ?? ''
      requisicoes.push(`${req.method} ${caminho}`)
      const json = (corpo: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(corpo))
      }
      const texto = Buffer.concat(chunks).toString('utf-8')

      if (req.method === 'POST' && caminho === '/graphql') {
        const { query } = JSON.parse(texto) as { query: string }
        if (query.includes('ItensDoQuadro')) {
          graphql.push('ItensDoQuadro')
          return json({
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: config.quadro.map((q, n) => ({
                    id: `item${n}`,
                    content: { number: q.pedido, corpo: null },
                    fieldValueByName: q.iteracaoId ? { iterationId: q.iteracaoId } : null,
                    pesoValue: q.peso === null ? null : { number: q.peso },
                  })),
                },
              },
            },
          })
        }
        if (query.includes('GetIterationField')) {
          graphql.push('GetIterationField')
          return json({
            data: {
              node: {
                fields: {
                  nodes: [
                    {
                      __typename: 'ProjectV2IterationField',
                      id: 'campoSprint',
                      name: 'Sprint',
                      configuration: {
                        iterations: [
                          { id: 'it_velha', title: 'S0', startDate: '2020-01-01', duration: 3 },
                          // começou ontem (UTC), dura 30 dias: cobre "hoje" em qualquer fuso
                          {
                            id: 'it_hoje',
                            title: 'S1',
                            startDate: new Date(Date.now() - 24 * HORA).toISOString().slice(0, 10),
                            duration: 30,
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          })
        }
        graphql.push('desconhecida')
        return json({ errors: [{ message: 'consulta não prevista no teste' }] }, 400)
      }
      if (req.method === 'GET' && caminho.startsWith(`/repos/${REPO}/pulls?state=open`)) {
        return json([])
      }
      if (req.method === 'GET' && caminho.startsWith(`/repos/${REPO}/issues?state=open`)) {
        return json([...issues.values()].filter((i) => i.state === 'open').map(emJson))
      }
      const um = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(caminho)
      if (um) {
        const alvo = issues.get(Number(um[1]))
        if (!alvo) return json({ message: 'Not Found' }, 404)
        if (req.method === 'GET') return json(emJson(alvo))
        if (req.method === 'PATCH') {
          const dados = JSON.parse(texto) as { title?: string; body?: string }
          escritas.push({ numero: alvo.number, ...dados })
          if (dados.title !== undefined) alvo.title = dados.title
          if (dados.body !== undefined) alvo.body = dados.body
          alvo.updatedAt = new Date()
          if (controle.respostaDoPatchComErro) return json({ message: 'Server Error' }, 500)
          return json(emJson(alvo))
        }
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  return { servidor, requisicoes, escritas, graphql, issues, controle }
}

describe.skipIf(!reachable)(
  'tarefas sem pedido: conferência, ajuste e fora da sprint (integration)',
  () => {
    const dbName = `gitorch_it_ligacao_tarefas_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    let dbUrl = ''
    let prisma: PrismaClient
    let servidor: Server | null = null

    beforeAll(async () => {
      psql(requireAdminUrl(), `CREATE DATABASE "${dbName}"`)
      dbUrl = withDatabase(requireAdminUrl(), dbName)
      applySchema(dbUrl)
      const { PrismaClient: PrismaDeVerdade } = await import('@prisma/client')
      prisma = new PrismaDeVerdade({ datasources: { db: { url: dbUrl } } })
    }, 120_000)

    beforeEach(() => {
      limparFreiosDeCota()
      limparCacheDeLeituraDoQuadro()
    })

    afterEach(async () => {
      limparFreiosDeCota()
      limparCacheDeLeituraDoQuadro()
      if (servidor) await new Promise<void>((resolve) => servidor!.close(() => resolve()))
      servidor = null
    })

    afterAll(async () => {
      if (prisma) await prisma.$disconnect()
      try {
        psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      } catch {}
    })

    function novoProjeto(autonomia = 'cuidar') {
      const projectId = randomUUID()
      psql(
        dbUrl,
        `INSERT INTO projects (id, wing_id, name, autonomia, updated_at) ` +
          `VALUES ('${projectId}', '${REPO}-${projectId}', 'repo', '${autonomia}', now())`
      )
      return projectId
    }

    async function iniciar(config: Parameters<typeof githubLocal>[0]) {
      const github = githubLocal(config)
      servidor = github.servidor
      await new Promise<void>((resolve) => servidor!.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`
      const fetchLocal: typeof fetch = (input, init) =>
        fetch(String(input).replace('https://api.github.com', base), init)
      return { github, fetchLocal }
    }

    const ghGetDe =
      (fetchLocal: typeof fetch) =>
      async (caminho: string): Promise<unknown> => {
        const resposta = await fetchLocal(`https://api.github.com${caminho}`)
        if (!resposta.ok) throw new Error(`${caminho} (${resposta.status})`)
        return resposta.json()
      }

    /** A escrita sai pela MESMA porta de produção: o fetch com a guarda de autonomia. */
    const ghSendDe =
      (fetchLocal: typeof fetch, nivel: () => string) =>
      async (metodo: 'PATCH', caminho: string, corpo: unknown): Promise<unknown> => {
        const fetchGuardado = fetchDoRepositorio({ nivel, fetchImpl: fetchLocal })
        const resposta = await fetchGuardado(`https://api.github.com${caminho}`, {
          method: metodo,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(corpo),
        })
        if (!resposta.ok) throw new Error(`${metodo} ${caminho} (${resposta.status})`)
        return resposta.json()
      }

    /** Uma passada da varredura, montada como o scheduler a monta (com o leitor de quadro real). */
    function varrer(args: { projectId: string; fetchLocal: typeof fetch; avisos?: string[] }) {
      return varrerRetratoDoProjeto({
        repo: REPO,
        ghGet: ghGetDe(args.fetchLocal),
        atualizarFicha: async (item) => {
          await atualizarFichaDoItem({
            prisma: prisma as unknown as PrismaDaFichaDoItem,
            projectId: args.projectId,
            tipo: item.tipo,
            numero: item.numero,
            estado: item.estado,
          })
        },
        onWarn: (m) => args.avisos?.push(m),
        conferirTarefa: montarConferenciaDoRetrato({
          prisma,
          projectId: args.projectId,
          repo: REPO,
          lerQuadro: criarLeitorDoQuadro({
            resolverQuadro: async () => ({ quadroId: 'Q1', token: 'token-de-teste' }),
            fetchImpl: args.fetchLocal,
          }),
          onWarn: (m) => args.avisos?.push(m),
        }),
      })
    }

    async function ficha(projectId: string, numero: number) {
      return prisma.repoItem.findUniqueOrThrow({
        where: { projectId_tipo_numero: { projectId, tipo: 'issue', numero } },
      })
    }

    async function conferencia(projectId: string, numero: number) {
      return (await ficha(projectId, numero)).conferencia as Record<string, unknown> | null
    }

    function eventos(projectId: string): string[] {
      const saida = psql(
        dbUrl,
        `SELECT payload->>'chave' FROM events WHERE project_id = '${projectId}' AND type = 'audit' ORDER BY 1`
      )
      return saida === '' ? [] : saida.split('\n')
    }

    /** O motor falso devolve o formulário real (schema infraIssue) preservando as referências do prompt. */
    function motorFalso() {
      return vi.fn(async (prompt: string) => {
        const numero = /tarefa #(\d+) de/.exec(prompt)?.[1] ?? '0'
        const corpo = prompt.split('Corpo original:')[1]?.split('</client_request>')[0] ?? ''
        const refs = [...corpo.matchAll(/#\d+|https:\/\/exemplo\.com\/t\/\d+/g)].map((m) => m[0])
        return JSON.stringify({
          fields: {
            titulo: `Tarefa ${numero} no padrão`,
            goal: `Objetivo da tarefa ${numero}. Referências: ${refs.join(' ')}`,
            taskDetails: 'Detalhes preservados do texto original.',
            taskDescription: 'Descrição reescrita.',
            implementationGuide: '1. ler o código\n2. ajustar',
            verificationCriteria: '- o teste novo passa\n- a suíte passa',
            dependencies: 'nenhuma',
            relatedFiles: 'src/x.ts',
            notes: 'sem notas',
          },
        })
      })
    }

    function missao(args: {
      projectId: string
      autonomia: string
      fetchLocal: typeof fetch
      execute: ReturnType<typeof motorFalso>
      nivelDoGuarda?: () => string
      env?: Record<string, string | undefined>
      esperas?: number[]
      ghSend?: ReturnType<typeof ghSendDe>
    }) {
      return rodarAjusteDoPoComPrisma({
        prisma,
        project: { id: args.projectId, wingId: REPO, autonomia: args.autonomia },
        ghGet: ghGetDe(args.fetchLocal),
        ghSend:
          args.ghSend ?? ghSendDe(args.fetchLocal, args.nivelDoGuarda ?? (() => args.autonomia)),
        execute: args.execute,
        contextBlocks: [],
        env: args.env ?? {},
        esperar: async (ms) => {
          args.esperas?.push(ms)
        },
      })
    }

    // ---------------------------------------------------------------- 4.1

    it('4.1: a varredura confere 3 tarefas e um bug solto; a segunda passada não muda nada', async () => {
      const projectId = novoProjeto()
      const { github, fetchLocal } = await iniciar({
        issues: [
          issue(101, { title: 'No padrão', body: CORPO_NO_PADRAO }),
          issue(102, { title: 'Parcial', body: '## Goal\n\ng\n\n## Task Details\n\nd' }),
          issue(103, { title: 'Nenhuma', body: 'só um parágrafo' }),
          issue(104, { title: 'Bug solto', body: 'quebrou', labels: ['bug'] }),
        ],
        quadro: [
          { pedido: 101, iteracaoId: 'it_hoje', peso: 3 },
          { pedido: 102, iteracaoId: null, peso: null },
          { pedido: 103, iteracaoId: 'it_velha', peso: null },
        ],
      })

      await varrer({ projectId, fetchLocal })

      const c101 = await conferencia(projectId, 101)
      expect(c101).toMatchObject({
        padraoOk: true,
        camposFaltando: [],
        pesoOk: true,
        peso: 3,
        estaNoQuadro: true,
        naSprint: true,
      })
      const c102 = await conferencia(projectId, 102)
      expect(c102).toMatchObject({
        padraoOk: false,
        pesoOk: false,
        estaNoQuadro: true,
        naSprint: false,
      })
      expect(c102?.['camposFaltando']).toEqual(
        expect.arrayContaining(['taskDescription', 'implementationGuide', 'verificationCriteria'])
      )
      expect(await conferencia(projectId, 103)).toMatchObject({
        padraoOk: false,
        estaNoQuadro: true,
        naSprint: false,
      })
      // o bug solto, fora do quadro e sem etiqueta de tarefa, nem foi conferido
      expect(await conferencia(projectId, 104)).toBeNull()

      // o estado (retrato do GitHub) segue intacto: a conferência mora em coluna própria
      expect((await ficha(projectId, 101)).estado).toMatchObject({ status: 'open' })
      expect(Object.keys((await ficha(projectId, 101)).estado as object)).not.toContain('padraoOk')

      // os dois fora do padrão abriram um evento cada; o que está no padrão, nenhum
      const primeiros = eventos(projectId)
      expect(primeiros).toHaveLength(2)
      expect(primeiros.every((c) => c.startsWith(`conferencia:${REPO}:`))).toBe(true)
      expect(primeiros.some((c) => c.startsWith(`conferencia:${REPO}:102:`))).toBe(true)
      expect(primeiros.some((c) => c.startsWith(`conferencia:${REPO}:103:`))).toBe(true)

      // o quadro foi lido uma vez (itens + sprint) e nenhuma escrita saiu
      expect(github.graphql.sort()).toEqual(['GetIterationField', 'ItensDoQuadro'])
      expect(github.escritas).toEqual([])

      // segunda passada: nada muda, nem a hora da conferência, nem os eventos; o quadro vem do cache
      const fotos1 = await Promise.all([101, 102, 103].map((n) => conferencia(projectId, n)))
      const atualizadoEm1 = psql(
        dbUrl,
        `SELECT string_agg(numero::text || ':' || (conferencia->>'conferidoEm'), ',' ORDER BY numero) FROM repo_items WHERE project_id = '${projectId}' AND tipo = 'issue' AND conferencia IS NOT NULL`
      )
      await varrer({ projectId, fetchLocal })
      const fotos2 = await Promise.all([101, 102, 103].map((n) => conferencia(projectId, n)))
      expect(fotos2).toEqual(fotos1)
      expect(
        psql(
          dbUrl,
          `SELECT string_agg(numero::text || ':' || (conferencia->>'conferidoEm'), ',' ORDER BY numero) FROM repo_items WHERE project_id = '${projectId}' AND tipo = 'issue' AND conferencia IS NOT NULL`
        )
      ).toBe(atualizadoEm1)
      expect(eventos(projectId)).toEqual(primeiros)
      expect(github.graphql).toHaveLength(2) // nenhuma leitura nova do quadro
    })

    it('4.1: corpo editado vira nova conferência; o que a missão guardou não se perde', async () => {
      const projectId = novoProjeto()
      const { github, fetchLocal } = await iniciar({
        issues: [issue(110, { body: 'solto #1110' })],
        quadro: [{ pedido: 110, iteracaoId: null, peso: null }],
      })
      await varrer({ projectId, fetchLocal })
      await prisma.repoItem.update({
        where: { projectId_tipo_numero: { projectId, tipo: 'issue', numero: 110 } },
        data: {
          conferencia: {
            ...((await conferencia(projectId, 110)) as object),
            original: { titulo: 'a', corpo: 'b' },
            ajuste: { estado: 'aplicado' },
          },
        },
      })
      github.issues.get(110)!.body = 'solto de outro jeito #1110'
      await varrer({ projectId, fetchLocal })
      const c = await conferencia(projectId, 110)
      expect(c).toMatchObject({ padraoOk: false, original: { titulo: 'a', corpo: 'b' } })
      expect(c?.['ajuste']).toMatchObject({ estado: 'aplicado' })
    })

    // ---------------------------------------------------------------- 4.2

    async function prepararCincoForaDoPadrao() {
      const projectId = novoProjeto('cuidar')
      const numeros = [201, 202, 203, 204, 205]
      const g = await iniciar({
        issues: numeros.map((n) => issue(n)),
        quadro: numeros.map((n) => ({ pedido: n, iteracaoId: null, peso: null })),
      })
      await varrer({ projectId, fetchLocal: g.fetchLocal })
      return { projectId, numeros, ...g }
    }

    it('4.2: reescreve no máximo 3 por missão, guardando o original, e o GitHub falso nunca vê mais de 3 PATCH', async () => {
      const { projectId, github, fetchLocal } = await prepararCincoForaDoPadrao()
      const execute = motorFalso()
      const esperas: number[] = []

      const r = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute, esperas })

      expect(TETO_DE_AJUSTES_POR_MISSAO).toBe(3)
      expect(r.aplicadas).toEqual([201, 202, 203])
      expect(github.escritas).toHaveLength(3)
      expect(esperas).toEqual([1000, 1000]) // em série, 1 s entre as escritas
      for (const escrita of github.escritas) {
        expect(escrita.body).toContain('<details><summary>Texto original</summary>')
        expect(escrita.body).toContain(`Texto solto da tarefa ${escrita.numero}.`)
        expect(escrita.body).toContain(`#${escrita.numero + 1000}`)
        expect(escrita.title).toBe(`Tarefa ${escrita.numero} no padrão`)
      }

      // o original ficou na ficha (e no corpo), e o painel tem o rastro com o link
      const c = await conferencia(projectId, 201)
      expect(c).toMatchObject({
        original: { titulo: 'Tarefa 201' },
        ajuste: { estado: 'aplicado' },
      })
      expect((c?.['original'] as { corpo: string }).corpo).toContain('Texto solto da tarefa 201.')
      expect(eventos(projectId).filter((x) => x.startsWith('ajuste:'))).toHaveLength(3)
      const texto = psql(
        dbUrl,
        `SELECT payload->>'texto' FROM events WHERE project_id = '${projectId}' AND payload->>'chave' LIKE 'ajuste:%' ORDER BY payload->>'chave' LIMIT 1`
      )
      expect(texto).toContain(`https://github.com/${REPO}/issues/201`)
      expect(texto).toContain('Como desfazer')

      // o motor foi usado só para as 3 escolhidas
      expect(execute).toHaveBeenCalledTimes(3)

      // a missão seguinte pega as 2 que sobraram (e só elas): as 3 já ajustadas não voltam
      const r2 = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute })
      expect(r2.aplicadas).toEqual([204, 205])
      expect(github.escritas).toHaveLength(5)
      const r3 = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute })
      expect(r3.aplicadas).toEqual([])
      expect(github.escritas).toHaveLength(5)
    })

    it('4.2: depois da reescrita, a próxima varredura vê a tarefa no padrão e preserva o original', async () => {
      const { projectId, fetchLocal } = await prepararCincoForaDoPadrao()
      await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })
      await varrer({ projectId, fetchLocal })
      const c = await conferencia(projectId, 201)
      expect(c).toMatchObject({ padraoOk: true, original: { titulo: 'Tarefa 201' } })
      expect(c?.['ajuste']).toMatchObject({ estado: 'aplicado' })
    })

    it('4.2: desfazer devolve título e corpo exatamente como eram', async () => {
      const { projectId, github, fetchLocal } = await prepararCincoForaDoPadrao()
      const original = { ...github.issues.get(201)! }
      await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })
      expect(github.issues.get(201)!.body).not.toBe(original.body)

      const r = await desfazerAjusteDaTarefaDoProjeto({
        prisma,
        projectId,
        repo: REPO,
        numero: 201,
        ghGet: ghGetDe(fetchLocal),
        ghSend: ghSendDe(fetchLocal, () => 'cuidar'),
      })

      expect(r).toEqual({ desfeito: true })
      expect(github.issues.get(201)!.title).toBe(original.title)
      expect(github.issues.get(201)!.body).toBe(original.body)
      expect(await conferencia(projectId, 201)).toMatchObject({ ajuste: { estado: 'desfeito' } })
      expect(eventos(projectId).some((c) => c.startsWith('ajuste-desfeito:'))).toBe(true)

      // a tarefa desfeita não é reescrita de novo com o mesmo texto
      await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })
      expect(github.issues.get(201)!.body).toBe(original.body)
    })

    /**
     * A tarefa é reescrita, uma pessoa a edita (fora do padrão, há mais de 24 h)
     * e o sistema a reescreve de novo. Devolve o texto de antes de cada rodada.
     */
    async function duasReescritasReais() {
      const projectId = novoProjeto('cuidar')
      const g = await iniciar({
        issues: [issue(701)],
        quadro: [{ pedido: 701, iteracaoId: null, peso: null }],
      })
      const o1 = { titulo: g.github.issues.get(701)!.title, corpo: g.github.issues.get(701)!.body! }
      await varrer({ projectId, fetchLocal: g.fetchLocal })
      await missao({
        projectId,
        autonomia: 'cuidar',
        fetchLocal: g.fetchLocal,
        execute: motorFalso(),
      })
      expect(g.github.issues.get(701)!.body).not.toBe(o1.corpo)

      const o2 = {
        titulo: 'Anotação de gente sobre a tarefa 701',
        corpo: 'Gente anotou algo solto, veja #1701 e https://exemplo.com/t/701.',
      }
      const humana = g.github.issues.get(701)!
      humana.title = o2.titulo
      humana.body = o2.corpo
      humana.updatedAt = new Date(Date.now() - 72 * HORA)
      await varrer({ projectId, fetchLocal: g.fetchLocal })
      const r = await missao({
        projectId,
        autonomia: 'cuidar',
        fetchLocal: g.fetchLocal,
        execute: motorFalso(),
      })
      expect(r.aplicadas).toEqual([701])
      // a pessoa mexeu no meio: a segunda rodada reescreveu o texto DELA
      expect(g.github.issues.get(701)!.body).toContain(o2.corpo)
      return { projectId, o1, o2, ...g }
    }

    it('4.2: segunda reescrita guarda o ORIGINAL VERDADEIRO e desfazer volta a ele', async () => {
      const { projectId, github, fetchLocal, o1, o2 } = await duasReescritasReais()
      const c = await conferencia(projectId, 701)
      expect(c?.['original']).toMatchObject({ titulo: o1.titulo, corpo: o1.corpo })
      expect(c?.['historico']).toEqual([
        expect.objectContaining({ titulo: o1.titulo, corpo: o1.corpo }),
        expect.objectContaining({ titulo: o2.titulo, corpo: o2.corpo }),
      ])

      const r = await desfazerAjusteDaTarefaDoProjeto({
        prisma,
        projectId,
        repo: REPO,
        numero: 701,
        ghGet: ghGetDe(fetchLocal),
        ghSend: ghSendDe(fetchLocal, () => 'cuidar'),
      })
      expect(r).toEqual({ desfeito: true })
      expect(github.issues.get(701)!.title).toBe(o1.titulo)
      expect(github.issues.get(701)!.body).toBe(o1.corpo)
    })

    it('4.2: desfazer para o ANTERIOR volta ao texto da pessoa, e o original segue guardado', async () => {
      const { projectId, github, fetchLocal, o1, o2 } = await duasReescritasReais()
      const r = await desfazerAjusteDaTarefaDoProjeto({
        prisma,
        projectId,
        repo: REPO,
        numero: 701,
        alvo: 'anterior',
        ghGet: ghGetDe(fetchLocal),
        ghSend: ghSendDe(fetchLocal, () => 'cuidar'),
      })
      expect(r).toEqual({ desfeito: true })
      expect(github.issues.get(701)!.title).toBe(o2.titulo)
      expect(github.issues.get(701)!.body).toBe(o2.corpo)
      expect((await conferencia(projectId, 701))?.['original']).toMatchObject({
        titulo: o1.titulo,
        corpo: o1.corpo,
      })

      // e a missão seguinte não reescreve de novo o texto que acabou de ser restaurado
      const escritasAntes = github.escritas.length
      await varrer({ projectId, fetchLocal })
      await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })
      expect(github.escritas).toHaveLength(escritasAntes)
    })

    it('4.2: PATCH aplicado no servidor mas com 500 para o cliente: vira "aplicado", com evento, e desfaz', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(801)],
        quadro: [{ pedido: 801, iteracaoId: null, peso: null }],
      })
      const original = { ...github.issues.get(801)! }
      await varrer({ projectId, fetchLocal })
      github.controle.respostaDoPatchComErro = true

      const r = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })

      expect(r.aplicadas).toEqual([801])
      expect(r.falhas).toEqual([])
      expect(github.issues.get(801)!.body).toContain('<details><summary>Texto original</summary>')
      expect(await conferencia(projectId, 801)).toMatchObject({
        ajuste: { estado: 'aplicado', confirmadoPorReleitura: true },
      })
      expect(eventos(projectId).filter((c) => c.startsWith('ajuste:'))).toHaveLength(1)

      github.controle.respostaDoPatchComErro = false
      const volta = await desfazerAjusteDaTarefaDoProjeto({
        prisma,
        projectId,
        repo: REPO,
        numero: 801,
        ghGet: ghGetDe(fetchLocal),
        ghSend: ghSendDe(fetchLocal, () => 'cuidar'),
      })
      expect(volta).toEqual({ desfeito: true })
      expect(github.issues.get(801)!.body).toBe(original.body)
    })

    it('4.2: sem autonomia "cuidar" nada é escrito e o motor nem é chamado', async () => {
      for (const autonomia of ['so_olhar', 'sugerir']) {
        limparCacheDeLeituraDoQuadro()
        const projectId = novoProjeto(autonomia)
        const { github, fetchLocal } = await iniciar({
          issues: [issue(301)],
          quadro: [{ pedido: 301, iteracaoId: null, peso: null }],
        })
        await varrer({ projectId, fetchLocal })
        const execute = motorFalso()
        const r = await missao({ projectId, autonomia, fetchLocal, execute })
        expect(r.aplicadas).toEqual([])
        expect(r.puladoPor).toBe('autonomia')
        expect(github.escritas).toEqual([])
        expect(execute).not.toHaveBeenCalled()
        expect(github.requisicoes.filter((q) => q.startsWith('PATCH'))).toEqual([])
        await new Promise<void>((resolve) => servidor!.close(() => resolve()))
        servidor = null
      }
    })

    it('4.2: a porta de saída recusa a escrita mesmo se o chamador errar o nível (defesa em camadas)', async () => {
      const projectId = novoProjeto('so_olhar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(302)],
        quadro: [{ pedido: 302, iteracaoId: null, peso: null }],
      })
      await varrer({ projectId, fetchLocal })
      // o chamador "acha" que é cuidar, mas a guarda de autonomia da saída lê so_olhar
      const r = await missao({
        projectId,
        autonomia: 'cuidar',
        nivelDoGuarda: () => 'so_olhar',
        fetchLocal,
        execute: motorFalso(),
      })
      expect(r.aplicadas).toEqual([])
      expect(r.falhas).toEqual([302])
      expect(github.escritas).toEqual([])
      // o original ficou guardado antes da tentativa, e a falha foi contada
      expect(await conferencia(projectId, 302)).toMatchObject({
        original: { titulo: 'Tarefa 302' },
        ajuste: { estado: 'falhou', falhas: 1 },
      })
    })

    it('4.2: interruptor desligado pela variável de ambiente: nada acontece', async () => {
      const { projectId, github, fetchLocal } = await prepararCincoForaDoPadrao()
      const execute = motorFalso()
      const r = await missao({
        projectId,
        autonomia: 'cuidar',
        fetchLocal,
        execute,
        env: { GITORCH_AJUSTE_DE_TAREFA: 'off' },
      })
      expect(r.puladoPor).toBe('interruptor')
      expect(github.escritas).toEqual([])
      expect(execute).not.toHaveBeenCalled()
    })

    it('4.2: sessão do dev viva, entrega em julgamento e edição humana recente seguram a escrita', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [
          issue(401), // sessão do dev viva
          issue(402), // PR aberto ligado
          issue(403, { updatedAt: new Date(Date.now() - 2 * HORA) }), // gente mexeu há 2 h
          issue(404, { labels: ['gitorch:task', 'jules'] }), // já entregue ao dev
          issue(405), // sessão do dev já encerrada: pode
        ],
        quadro: [401, 402, 403, 404, 405].map((n) => ({ pedido: n, iteracaoId: null, peso: null })),
      })
      await varrer({ projectId, fetchLocal })
      await prisma.devSession.create({
        data: {
          projectId,
          issueNumber: 401,
          sessionName: `sessions/${randomUUID()}`,
          state: 'IN_PROGRESS',
        },
      })
      await prisma.devSession.create({
        data: {
          projectId,
          issueNumber: 405,
          sessionName: `sessions/${randomUUID()}`,
          state: 'COMPLETED',
          closedAt: new Date(),
          closedReason: 'merged',
        },
      })
      await prisma.repoItem.create({
        data: { projectId, tipo: 'pr', numero: 900, estado: { status: 'open' }, issueNumber: 402 },
      })

      const execute = motorFalso()
      const r = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute })

      expect(r.aplicadas).toEqual([405])
      expect(r.bloqueadas.map((b) => b.numero).sort()).toEqual([401, 402, 403, 404])
      expect(github.escritas.map((e) => e.numero)).toEqual([405])
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it('4.2: parecer travado num PR da tarefa também segura a escrita', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(410)],
        quadro: [{ pedido: 410, iteracaoId: null, peso: null }],
      })
      await varrer({ projectId, fetchLocal })
      await prisma.repoItem.create({
        data: {
          projectId,
          tipo: 'pr',
          numero: 901,
          estado: { status: 'closed' },
          issueNumber: 410,
          parecerTravadoAte: new Date(Date.now() + 10 * 60_000),
          parecerTravaHeadSha: 'abc',
        },
      })
      const r = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })
      expect(r.aplicadas).toEqual([])
      expect(github.escritas).toEqual([])
    })

    it('4.2: o texto que mudou entre a conferência e a escrita (gente editou) não é sobrescrito', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(420)],
        quadro: [{ pedido: 420, iteracaoId: null, peso: null }],
      })
      await varrer({ projectId, fetchLocal })
      github.issues.get(420)!.body = `${github.issues.get(420)!.body} (editado)`
      const r = await missao({ projectId, autonomia: 'cuidar', fetchLocal, execute: motorFalso() })
      expect(r.aplicadas).toEqual([])
      expect(github.escritas).toEqual([])
    })

    it('4.2: formulário do motor que perde uma referência não escreve nada e o motivo vai ao painel', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(430)],
        quadro: [{ pedido: 430, iteracaoId: null, peso: null }],
      })
      await varrer({ projectId, fetchLocal })
      const execute = vi.fn(async () =>
        JSON.stringify({
          fields: {
            titulo: 'Tarefa sem as referências',
            goal: 'objetivo sem nenhuma referência',
            taskDetails: 'd',
            taskDescription: 'd',
            implementationGuide: 'i',
            verificationCriteria: '- passa',
            dependencies: 'nenhuma',
            relatedFiles: 'src/x.ts',
            notes: 'n',
          },
        })
      )
      const r = await missao({
        projectId,
        autonomia: 'cuidar',
        fetchLocal,
        execute: execute as unknown as ReturnType<typeof motorFalso>,
      })
      expect(r.aplicadas).toEqual([])
      expect(r.invalidas).toEqual([430])
      expect(github.escritas).toEqual([])
      expect(eventos(projectId).some((c) => c.includes(':invalido'))).toBe(true)
      expect(await conferencia(projectId, 430)).toMatchObject({ ajuste: { estado: 'invalido' } })
      expect(await conferencia(projectId, 430)).not.toHaveProperty('original')
    })

    it('4.2: erro de escrita com emoji na fronteira do corte do motivo grava a ficha e volta do jsonb', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(440)],
        quadro: [{ pedido: 440, iteracaoId: null, peso: null }],
      })
      await varrer({ projectId, fetchLocal })
      const emoji = '\u{1F600}'
      // `String(err)` começa com "Error: " (7 unidades): o emoji cai nas unidades 199-200, a fronteira do corte em 200.
      const ghSend = async (): Promise<unknown> => {
        throw new Error(`${'y'.repeat(192)}${emoji}${'z'.repeat(100)}`)
      }

      const r = await missao({
        projectId,
        autonomia: 'cuidar',
        fetchLocal,
        execute: motorFalso(),
        ghSend,
      })

      expect(r.aplicadas).toEqual([])
      expect(github.escritas).toEqual([])
      const ajuste = (await conferencia(projectId, 440))?.['ajuste'] as {
        estado: string
        motivo: string
      }
      expect(ajuste.estado).toBe('falhou')
      expect(ajuste.motivo).toContain(emoji)
      expect(Array.from(ajuste.motivo)).toHaveLength(200)
      const cru = psql(
        dbUrl,
        `SELECT conferencia::text FROM repo_items WHERE project_id = '${projectId}' AND numero = 440`
      )
      expect(cru).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i)
    })

    // ---------------------------------------------------------------- 4.3

    it('4.3: tarefa fora da sprint com peso e posição vira só evento de painel, sem nenhuma chamada ao GitHub', async () => {
      const projectId = novoProjeto('cuidar')
      const { github, fetchLocal } = await iniciar({
        issues: [issue(501, { body: CORPO_NO_PADRAO }), issue(502, { body: CORPO_NO_PADRAO })],
        quadro: [
          { pedido: 501, iteracaoId: 'it_hoje', peso: 3 },
          { pedido: 502, iteracaoId: null, peso: 3 },
        ],
      })
      await varrer({ projectId, fetchLocal })
      const chamadasAntes = github.requisicoes.length

      const r = await registrarForaDaSprintComPrisma({
        prisma,
        projectId,
        repo: REPO,
        fila: [
          { pedido: 501, peso: 3 },
          { pedido: 502, peso: 3 },
        ],
      })

      expect(r.registradas).toEqual([502]) // a 501 está na sprint
      expect(github.requisicoes).toHaveLength(chamadasAntes)
      expect(github.escritas).toEqual([])
      expect(eventos(projectId).filter((c) => c.startsWith('fora-da-sprint:'))).toHaveLength(1)

      // repetir não duplica
      const de_novo = await registrarForaDaSprintComPrisma({
        prisma,
        projectId,
        repo: REPO,
        fila: [
          { pedido: 501, peso: 3 },
          { pedido: 502, peso: 3 },
        ],
      })
      expect(de_novo.registradas).toEqual([])
      expect(eventos(projectId).filter((c) => c.startsWith('fora-da-sprint:'))).toHaveLength(1)
    })
  }
)
