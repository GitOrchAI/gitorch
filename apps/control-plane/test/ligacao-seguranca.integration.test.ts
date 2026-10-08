import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  varrerSegurancaDosProjetos,
  type CredencialDaSeguranca,
  type ProjetoDaSeguranca,
} from '../src/services/varredura-de-seguranca.js'
import { varrerRetratoDoProjeto } from '../src/services/varredura-do-retrato.js'
import { atualizarFichaDoItem, type PrismaDaFichaDoItem } from '../src/services/ficha-do-item.js'
import { limparFreiosDeCota } from '../src/services/freio-de-cota-do-github.js'
import {
  criarGitHubFalso,
  WORKFLOW_FIXADO,
  WORKFLOW_POR_TAG,
  type RepositorioFalso,
} from '../src/test/github-de-seguranca-fake.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui.
vi.unmock('@prisma/client')

/**
 * Nota de segurança e conformidade, de ponta a ponta, contra o banco real e um
 * GitHub de mentira num servidor HTTP local. As respostas do servidor têm o
 * formato e o texto das que a API do GitHub devolveu quando foi lida (404 do
 * CODEOWNERS na raiz, árvore com `.github/CODEOWNERS`, 403 "Upgrade to GitHub
 * Pro", 404 "Branch not protected", SBOM 200 e 404).
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

const HORA = 3_600_000
const TOKEN = 'token-de-teste'
const CREDENCIAL: CredencialDaSeguranca = { origem: 'cliente ou dono', token: TOKEN }

// Os três repositórios reais da leitura, com nomes neutros.
const PUBLICO_COM_PROTECAO: RepositorioFalso = {
  // checagens obrigatórias, histórico linear, sem force-push, SEM revisão obrigatória
  protecao: 'checks-sem-revisao',
  permissaoDoToken: 'read',
  arquivos: {
    'SECURITY.md': '# política',
    '.github/dependabot.yml': 'version: 2',
    '.github/workflows/ci.yml': WORKFLOW_FIXADO,
    '.github/workflows/pages.yml': WORKFLOW_POR_TAG,
  },
  sbom: null,
}
const PRIVADO_PLANO_GRATIS: RepositorioFalso = {
  protecao: 'plano-gratis',
  permissaoDoToken: 'write',
  arquivos: {
    '.github/CODEOWNERS': '* @dono',
    '.github/dependabot.yml': 'version: 2',
    '.github/workflows/cd.yml': WORKFLOW_POR_TAG,
    'package.json': '{}',
  },
  sbom: [
    { name: 'left-pad', licenca: 'MIT' },
    { name: 'biblioteca-livre', licenca: 'GPL-3.0-only' },
    { name: 'escolhivel', licenca: 'GPL-3.0-only OR MIT' },
    { name: 'fraca', licenca: 'LGPL-3.0-or-later' },
    { name: 'sem-licenca', licenca: null },
  ],
}
const PRIVADO_SEM_NADA: RepositorioFalso = {
  protecao: 'plano-gratis',
  permissaoDoToken: 'read',
  arquivos: {
    '.github/workflows/ci.yml': WORKFLOW_POR_TAG,
    '.github/workflows/deploy.yml': WORKFLOW_POR_TAG,
  },
  sbom: null,
}

describe.skipIf(!reachable)('nota de segurança e conformidade (integration)', () => {
  const dbName = `gitorch_it_ligacao_seguranca_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  let dbUrl = ''
  let prisma: PrismaClient
  let servidor: Server | null = null
  let contador = 0

  beforeAll(async () => {
    psql(requireAdminUrl(), `CREATE DATABASE "${dbName}"`)
    dbUrl = withDatabase(requireAdminUrl(), dbName)
    applySchema(dbUrl)
    const { PrismaClient: PrismaDeVerdade } = await import('@prisma/client')
    prisma = new PrismaDeVerdade({ datasources: { db: { url: dbUrl } } })
  }, 120_000)

  beforeEach(() => {
    limparFreiosDeCota()
  })

  afterEach(async () => {
    limparFreiosDeCota()
    if (servidor) await new Promise<void>((resolve) => servidor!.close(() => resolve()))
    servidor = null
  })

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    try {
      psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } catch {}
  })

  /** Projeto no banco; devolve também o que a etapa recebe do scheduler. */
  async function novoProjeto(
    rotulo: string,
    runtimeConfig: Record<string, unknown> | null = null
  ): Promise<ProjetoDaSeguranca & { projectId: string }> {
    contador += 1
    const projectId = randomUUID()
    const wingId = `acme/${rotulo}-${contador}`
    const config = runtimeConfig ? `'${JSON.stringify(runtimeConfig)}'::jsonb` : 'NULL'
    psql(
      dbUrl,
      `INSERT INTO projects (id, wing_id, name, autonomia, runtime_config, updated_at) ` +
        `VALUES ('${projectId}', '${wingId}', '${wingId}', 'cuidar', ${config}, now())`
    )
    return { id: projectId, projectId, wingId, runtimeConfig }
  }

  /** O GitHub de mentira atrás de HTTP real (hosts da API e do texto cru). */
  async function iniciarGitHub(configuracoes: Record<string, RepositorioFalso>) {
    const github = criarGitHubFalso(configuracoes)
    const barradas: string[] = []
    servidor = createServer((req, res) => {
      const caminho = req.url ?? ''
      const cuida = async () => {
        if (caminho.startsWith('/raw/')) {
          const r = github.atender(`https://raw.githubusercontent.com${caminho.slice(4)}`)
          res.writeHead(r.status, r.headers)
          res.end(r.corpo)
          return
        }
        const rest = caminho.slice(4)
        const repo = /^\/repos\/([^/]+\/[^/?]+)/.exec(rest)?.[1]
        const atraso = repo ? configuracoes[repo]?.latenciaMs : undefined
        if (atraso) await new Promise((r) => setTimeout(r, atraso))
        // A varredura de 30 min lista pulls e issues abertas.
        if (/^\/repos\/[^/]+\/[^/]+\/(pulls|issues)\?/.test(rest)) {
          github.chamadas.push(`api.github.com${rest}`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('[]')
          return
        }
        const r = github.atender(
          `https://api.github.com${rest}`,
          req.headers.authorization ?? undefined
        )
        res.writeHead(r.status, r.headers)
        res.end(r.corpo)
      }
      cuida().catch((err) => {
        barradas.push(String(err))
        res.writeHead(500)
        res.end()
      })
    })
    await new Promise<void>((resolve) => servidor!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`
    const fetchLocal: typeof fetch = (input, init) =>
      fetch(
        String(input)
          .replace('https://api.github.com', `${base}/api`)
          .replace('https://raw.githubusercontent.com', `${base}/raw`),
        init
      )
    return { github, fetchLocal, barradas }
  }

  async function passar(args: {
    projetos: ProjetoDaSeguranca[]
    fetchLocal: typeof fetch
    agora?: Date
    credenciais?: CredencialDaSeguranca[]
    falhas?: Map<string, number>
    orcamentoMs?: number
    infos?: string[]
    avisos?: string[]
  }) {
    return varrerSegurancaDosProjetos({
      prisma,
      projetos: args.projetos,
      agora: args.agora ?? new Date(),
      credenciais: async () => args.credenciais ?? [CREDENCIAL],
      fetchImpl: args.fetchLocal,
      falhasRecentes: args.falhas ?? new Map(),
      ...(args.orcamentoMs ? { orcamentoMs: args.orcamentoMs } : {}),
      onInfo: (m) => args.infos?.push(m),
      onWarn: (m) => args.avisos?.push(m),
    })
  }

  async function ficha(projectId: string, tipo: 'seguranca' | 'conformidade') {
    return prisma.repoItem.findUnique({
      where: { projectId_tipo_numero: { projectId, tipo, numero: 0 } },
    })
  }

  interface EstadoMedido {
    status?: string
    nota?: number | null
    maximo?: number
    medidoEm?: string
    formula: string[]
    checks: Record<string, unknown>
    informativos?: unknown
    documentos?: unknown
    problemas: string[]
    licencas: {
      estado: string
      motivo?: string
      listaUsada?: string[]
      emAtencao?: unknown[]
    }
    indiciosDePii: { estado: string; arquivosLidos: string[]; indicios: unknown[] }
  }

  function estadoDe(f: { estado: unknown } | null): EstadoMedido {
    return (f?.estado ?? {}) as EstadoMedido
  }

  function chavesDeEventos(projectId: string): string[] {
    const saida = psql(
      dbUrl,
      `SELECT payload->>'chave' FROM events WHERE project_id = '${projectId}' AND type = 'audit' ORDER BY 1`
    )
    return saida === '' ? [] : saida.split('\n')
  }

  // ------------------------------------------------------------------ regressão

  it('tabela de regressão: os três casos reais saem com as notas dos critérios corrigidos', async () => {
    const publico = await novoProjeto('publico')
    const privado = await novoProjeto('privado')
    const vazio = await novoProjeto('vazio')
    const { fetchLocal } = await iniciarGitHub({
      [publico.wingId]: PUBLICO_COM_PROTECAO,
      [privado.wingId]: PRIVADO_PLANO_GRATIS,
      [vazio.wingId]: PRIVADO_SEM_NADA,
    })
    const projetos = [publico, privado, vazio]
    // Um projeto por passada: três passadas medem os três.
    for (let i = 0; i < 3; i += 1) await passar({ projetos, fetchLocal })

    const tabela = await Promise.all(
      projetos.map(async (p) => {
        const e = estadoDe(await ficha(p.projectId, 'seguranca'))
        return { repo: p.wingId.split('-')[0], nota: e['nota'], maximo: e['maximo'] }
      })
    )
    expect(tabela).toEqual([
      // proteção OK (checagens), permissão read OK, SECURITY.md OK, Dependabot OK;
      // Actions soltas e sem CODEOWNERS => 4 de 6
      { repo: 'acme/publico', nota: 67, maximo: 6 },
      // proteção fora do denominador (plano grátis); CODEOWNERS (.github/) e Dependabot OK;
      // Actions soltas, permissão write e sem SECURITY.md => 2 de 5
      { repo: 'acme/privado', nota: 40, maximo: 5 },
      // proteção fora do denominador; só a permissão read passa => 1 de 5
      { repo: 'acme/vazio', nota: 20, maximo: 5 },
    ])
    const checksPrivado = estadoDe(await ficha(privado.projectId, 'seguranca'))['checks']
    expect(checksPrivado).toEqual({
      branchProtection: null,
      actionsFixadasPorSha: false,
      permissaoPadraoDoToken: 'write',
      codeowners: true,
      securityMd: false,
      dependabotConfigurado: true,
    })
  })

  it('grava UMA linha por repositório (tipo seguranca, número 0) com o formato combinado', async () => {
    const p = await novoProjeto('publico')
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: PUBLICO_COM_PROTECAO,
    })
    const agora = new Date('2026-10-08T12:00:00Z')
    await passar({ projetos: [p], fetchLocal, agora })
    const linhas = await prisma.repoItem.findMany({
      where: { projectId: p.projectId, tipo: 'seguranca' },
    })
    expect(linhas).toHaveLength(1)
    expect(linhas[0]?.numero).toBe(0)
    const e = estadoDe(linhas[0] ?? null)
    expect(e['status']).toBe('medido')
    expect(e['nota']).toBe(67)
    expect(e['maximo']).toBe(6)
    expect(e['medidoEm']).toBe(agora.toISOString())
    expect(Array.isArray(e['formula'])).toBe(true)
    expect(e['formula'][0]).toContain('checagens obrigatórias')
    expect(e['informativos']).toEqual({ revisaoObrigatoria: false })
  })

  it('a varredura de 30 min do retrato NÃO apaga a linha de segurança nem a de conformidade', async () => {
    const p = await novoProjeto('privado')
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    await passar({ projetos: [p], fetchLocal })
    const antesSeg = estadoDe(await ficha(p.projectId, 'seguranca'))
    const antesConf = estadoDe(await ficha(p.projectId, 'conformidade'))
    expect(antesSeg['nota']).toBe(40)
    expect(antesConf['status']).toBe('medido')

    await varrerRetratoDoProjeto({
      repo: p.wingId,
      ghGet: async (caminho) => {
        const r = await fetchLocal(`https://api.github.com${caminho}`)
        if (!r.ok) throw new Error(`${caminho} (${r.status})`)
        return r.json()
      },
      atualizarFicha: async (item) => {
        await atualizarFichaDoItem({
          prisma: prisma as unknown as PrismaDaFichaDoItem,
          projectId: p.projectId,
          tipo: item.tipo,
          numero: item.numero,
          estado: item.estado,
        })
      },
    })

    expect(estadoDe(await ficha(p.projectId, 'seguranca'))).toEqual(antesSeg)
    expect(estadoDe(await ficha(p.projectId, 'conformidade'))).toEqual(antesConf)
  })

  // ------------------------------------------------------------------ gate e orçamento

  it('segunda passada dentro de 24 h não chama o GitHub (o gate é a própria ficha)', async () => {
    const p = await novoProjeto('privado')
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    const primeira = await passar({ projetos: [p], fetchLocal })
    expect(primeira.resultado).toBe('medido')
    const depois = github.chamadas.length
    expect(depois).toBeGreaterThan(0)

    // Outra "execução" do processo: sem memória nenhuma, só o banco.
    const segunda = await passar({ projetos: [p], fetchLocal, falhas: new Map() })
    expect(segunda.resultado).toBe('nada-a-fazer')
    expect(github.chamadas.length).toBe(depois)
  })

  it('orçamento por repositório: no máximo 6 chamadas à API por dia na segurança (mais 3 blobs e o SBOM na semana)', async () => {
    const p = await novoProjeto('publico')
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: PUBLICO_COM_PROTECAO,
    })
    await passar({ projetos: [p], fetchLocal })
    const api = github.chamadas.filter((c) => c.startsWith('api.github.com'))
    // repositório (branch padrão) + proteção + permissão + árvore + workflows
    // + SBOM da conformidade semanal
    expect(api).toHaveLength(6)
    expect(api.filter((c) => c.includes('/git/blobs/'))).toHaveLength(0)

    // 24 h e 1 min depois: só a segurança vence; sem SBOM nem blobs de novo.
    const antes = github.chamadas.length
    await passar({
      projetos: [p],
      fetchLocal,
      agora: new Date(Date.now() + 24 * HORA + 60_000),
    })
    const novas = github.chamadas.slice(antes).filter((c) => c.startsWith('api.github.com'))
    expect(novas).toHaveLength(5)
    expect(novas.some((c) => c.includes('dependency-graph/sbom'))).toBe(false)
  })

  it('ficha de segurança com 25 h: mede de novo; a conformidade (semanal) não repete', async () => {
    const p = await novoProjeto('privado')
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    await passar({ projetos: [p], fetchLocal })
    psql(
      dbUrl,
      `UPDATE repo_items SET atualizado_em = now() - interval '25 hours' ` +
        `WHERE project_id = '${p.projectId}' AND tipo = 'seguranca'`
    )
    const antes = github.chamadas.length
    const r = await passar({ projetos: [p], fetchLocal })
    expect(r.resultado).toBe('medido')
    expect(github.chamadas.length).toBeGreaterThan(antes)
    expect(github.chamadas.slice(antes).some((c) => c.includes('/sbom'))).toBe(false)

    psql(
      dbUrl,
      `UPDATE repo_items SET atualizado_em = now() - interval '8 days' ` +
        `WHERE project_id = '${p.projectId}' AND tipo = 'conformidade'`
    )
    const antesSbom = github.chamadas.filter((c) => c.includes('/sbom')).length
    await passar({
      projetos: [p],
      fetchLocal,
      agora: new Date(Date.now() + 25 * HORA),
    })
    expect(github.chamadas.filter((c) => c.includes('/sbom')).length).toBe(antesSbom + 1)
  })

  it('no máximo 1 projeto por passada, o de ficha mais antiga primeiro', async () => {
    const a = await novoProjeto('a')
    const b = await novoProjeto('b')
    const c = await novoProjeto('c')
    const { fetchLocal } = await iniciarGitHub({
      [a.wingId]: PRIVADO_SEM_NADA,
      [b.wingId]: PRIVADO_SEM_NADA,
      [c.wingId]: PRIVADO_SEM_NADA,
    })
    // b já foi medido há 25 h; a e c nunca.
    await passar({ projetos: [b], fetchLocal })
    psql(
      dbUrl,
      `UPDATE repo_items SET atualizado_em = now() - interval '25 hours' WHERE project_id = '${b.projectId}'`
    )
    const r = await passar({ projetos: [b, a, c], fetchLocal })
    expect(r.resultado).toBe('medido')
    expect(r.aguardando).toBe(2)
    const medidos = await prisma.repoItem.findMany({
      where: { projectId: { in: [a.projectId, c.projectId] }, tipo: 'seguranca' },
    })
    // exatamente um dos dois sem ficha foi medido (a ordem entre eles é a da lista)
    expect(medidos).toHaveLength(1)
  })

  it('abandona o projeto após o orçamento de tempo: não grava nada e não insiste na hora', async () => {
    const lento = await novoProjeto('lento')
    const { fetchLocal } = await iniciarGitHub({
      [lento.wingId]: { ...PRIVADO_PLANO_GRATIS, latenciaMs: 1_500 },
    })
    const avisos: string[] = []
    const falhas = new Map<string, number>()
    const inicio = Date.now()
    const r = await passar({
      projetos: [lento],
      fetchLocal,
      orcamentoMs: 300,
      falhas,
      avisos,
    })
    const levou = Date.now() - inicio
    expect(r.resultado).toBe('abandonado')
    expect(levou).toBeLessThan(1_200)
    expect(await ficha(lento.projectId, 'seguranca')).toBeNull()
    expect(await ficha(lento.projectId, 'conformidade')).toBeNull()
    expect(avisos.some((a) => a.includes('abandon') && a.includes(lento.wingId))).toBe(true)
    expect(falhas.has(lento.id)).toBe(true)

    // O mesmo processo não repete o projeto na passada seguinte.
    const outra = await passar({ projetos: [lento], fetchLocal, orcamentoMs: 300, falhas })
    expect(outra.resultado).toBe('nada-a-fazer')
  })

  it('freio de cota: o 403 de limite de taxa descarta a passada inteira e a seguinte pula com UMA linha de log', async () => {
    const p = await novoProjeto('cota')
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: { ...PRIVADO_PLANO_GRATIS, limiteDeTaxa: true },
    })
    const infos: string[] = []
    const primeira = await passar({ projetos: [p], fetchLocal, infos })
    expect(primeira.resultado).toBe('freio')
    expect(await ficha(p.projectId, 'seguranca')).toBeNull()

    const chamadasAntes = github.chamadas.length
    const segunda = await passar({ projetos: [p], fetchLocal, infos })
    const terceira = await passar({ projetos: [p], fetchLocal, infos })
    expect(segunda.resultado).toBe('freio')
    expect(terceira.resultado).toBe('freio')
    expect(github.chamadas.length).toBe(chamadasAntes)
    // Uma linha por passada: a que descartou a leitura e as duas que pularam.
    expect(infos.filter((m) => m.includes('freio de cota'))).toHaveLength(3)
  })

  it('403 de PERMISSÃO (cota sobrando) não freia: a nota sai com o que deu para medir', async () => {
    const p = await novoProjeto('permissao')
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: { ...PRIVADO_PLANO_GRATIS, protecao: 'sem-permissao' },
    })
    const r = await passar({ projetos: [p], fetchLocal })
    expect(r.resultado).toBe('medido')
    expect(estadoDe(await ficha(p.projectId, 'seguranca'))['checks']['branchProtection']).toBeNull()
  })

  it('credenciais: a do cliente primeiro; a do App só completa o que faltou', async () => {
    const p = await novoProjeto('cred')
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: {
        ...PUBLICO_COM_PROTECAO,
        protecaoExigeToken: 'token-do-app',
      },
    })
    await passar({
      projetos: [p],
      fetchLocal,
      credenciais: [
        { origem: 'cliente ou dono', token: 'token-do-cliente' },
        { origem: 'App do produto', token: 'token-do-app' },
      ],
    })
    const e = estadoDe(await ficha(p.projectId, 'seguranca'))
    expect(e['checks']['branchProtection']).toBe(true)
    // a segunda credencial só repetiu a proteção, não a árvore nem as permissões
    const protecoes = github.chamadas.filter((c) => c.includes('/protection'))
    expect(protecoes).toHaveLength(2)
    expect(github.chamadas.filter((c) => c.includes('/git/trees/'))).toHaveLength(1)
    expect(github.chamadas.filter((c) => c.includes('/permissions/workflow'))).toHaveLength(1)
  })

  it('sem nenhuma credencial: avisa, não grava, e não insiste por 3 h', async () => {
    const p = await novoProjeto('semcred')
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    const avisos: string[] = []
    const falhas = new Map<string, number>()
    const r = await passar({ projetos: [p], fetchLocal, credenciais: [], avisos, falhas })
    expect(r.resultado).toBe('sem-credencial')
    expect(github.chamadas).toHaveLength(0)
    expect(await ficha(p.projectId, 'seguranca')).toBeNull()
    expect(avisos).toHaveLength(1)
    expect(falhas.has(p.id)).toBe(true)
  })

  it('nada verificado (token sem alcance nenhum): não grava nota inventada', async () => {
    const p = await novoProjeto('cego')
    // O repositório não existe para o servidor: tudo responde 404.
    const { fetchLocal } = await iniciarGitHub({})
    const falhas = new Map<string, number>()
    const r = await passar({ projetos: [p], fetchLocal, falhas })
    expect(r.resultado).toBe('sem-medida')
    expect(await ficha(p.projectId, 'seguranca')).toBeNull()
    expect(falhas.has(p.id)).toBe(true)
  })

  // ------------------------------------------------------------------ painel

  it('evento de painel só quando a nota muda', async () => {
    const p = await novoProjeto('privado')
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    await passar({ projetos: [p], fetchLocal })
    const eventosDaNota = () =>
      chavesDeEventos(p.projectId).filter((c) => c.startsWith('nota-de-seguranca:'))
    expect(eventosDaNota()).toHaveLength(1)
    expect(eventosDaNota()[0]).toContain(`nota-de-seguranca:${p.wingId}:`)

    // 25 h depois, mesma nota: nenhum evento novo.
    psql(
      dbUrl,
      `UPDATE repo_items SET atualizado_em = now() - interval '25 hours' WHERE project_id = '${p.projectId}' AND tipo = 'seguranca'`
    )
    await passar({ projetos: [p], fetchLocal })
    expect(eventosDaNota()).toHaveLength(1)
  })

  it('a nota que sobe depois de uma correção gera o segundo evento, com a nota antiga no texto', async () => {
    const p = await novoProjeto('evolui')
    const config: RepositorioFalso = {
      ...PRIVADO_PLANO_GRATIS,
      arquivos: { ...PRIVADO_PLANO_GRATIS.arquivos },
    }
    const { fetchLocal } = await iniciarGitHub({ [p.wingId]: config })
    await passar({ projetos: [p], fetchLocal })
    expect(estadoDe(await ficha(p.projectId, 'seguranca'))['nota']).toBe(40)

    // O dono fixou as Actions e escreveu o SECURITY.md.
    config.arquivos['.github/workflows/cd.yml'] = WORKFLOW_FIXADO
    config.arquivos['SECURITY.md'] = '# política'
    psql(
      dbUrl,
      `UPDATE repo_items SET atualizado_em = now() - interval '25 hours' WHERE project_id = '${p.projectId}' AND tipo = 'seguranca'`
    )
    await passar({ projetos: [p], fetchLocal })
    expect(estadoDe(await ficha(p.projectId, 'seguranca'))['nota']).toBe(80)
    const textos = psql(
      dbUrl,
      `SELECT payload->>'texto' FROM events WHERE project_id = '${p.projectId}' AND payload->>'chave' LIKE 'nota-de-seguranca:%' ORDER BY created_at`
    ).split('\n')
    expect(textos).toHaveLength(2)
    expect(textos[1]).toContain('80')
    expect(textos[1]).toContain('40')
  })

  // ------------------------------------------------------------------ conformidade

  it('conformidade: SBOM 200 grava as licenças em atenção (padrão copyleft forte) e avisa o painel uma vez', async () => {
    const p = await novoProjeto('privado')
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    await passar({ projetos: [p], fetchLocal })
    const e = estadoDe(await ficha(p.projectId, 'conformidade'))
    expect(e['status']).toBe('medido')
    expect(e['licencas']).toMatchObject({
      estado: 'verificado',
      total: 5,
      semLicenca: 1,
      emAtencaoTotal: 1,
      emAtencao: [{ nome: 'biblioteca-livre', licenca: 'GPL-3.0-only' }],
    })
    expect(e['documentos']).toEqual({
      codeownersAusente: false,
      securityMdAusente: true,
      actionsSemSha: true,
    })
    expect(e['problemas']).toEqual(
      expect.arrayContaining([
        'security-md-ausente',
        'actions-sem-sha',
        'licenca:biblioteca-livre:GPL-3.0-only',
      ])
    )
    const eventos = chavesDeEventos(p.projectId).filter((c) => c.startsWith('conformidade:'))
    expect(eventos).toHaveLength(1)

    // Nada novo uma semana depois: sem evento repetido.
    psql(
      dbUrl,
      `UPDATE repo_items SET atualizado_em = now() - interval '8 days' WHERE project_id = '${p.projectId}'`
    )
    await passar({ projetos: [p], fetchLocal, agora: new Date(Date.now() + 8 * 24 * HORA) })
    expect(chavesDeEventos(p.projectId).filter((c) => c.startsWith('conformidade:'))).toHaveLength(
      1
    )
  })

  it('conformidade: SBOM 404 vira "não verificado" com motivo, nunca lista vazia que parece "tudo ok"', async () => {
    const p = await novoProjeto('publico')
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: PUBLICO_COM_PROTECAO,
    })
    await passar({ projetos: [p], fetchLocal })
    const e = estadoDe(await ficha(p.projectId, 'conformidade'))
    expect(e['licencas'].estado).toBe('nao-verificado')
    expect(e['licencas'].motivo).toContain('404')
    expect(e['licencas']).not.toHaveProperty('emAtencao')
    expect(e['licencas']).not.toHaveProperty('total')
  })

  it('conformidade: emoji na fronteira do corte e surrogate solto vindos do SBOM gravam no jsonb e voltam', async () => {
    const p = await novoProjeto('astral')
    const EMOJI = '\u{1F600}'
    const nomeNaFronteira = `${'n'.repeat(198)}${EMOJI}${'z'.repeat(60)}`
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: {
        ...PRIVADO_PLANO_GRATIS,
        sbom: [
          { name: nomeNaFronteira, licenca: `GPL-3.0-only AND ${nomeNaFronteira}` },
          { name: 'solto\uD83D', licenca: 'AGPL-3.0-only' },
        ],
      },
    })
    const avisos: string[] = []
    await passar({ projetos: [p], fetchLocal, avisos })

    const e = estadoDe(await ficha(p.projectId, 'conformidade'))
    expect(avisos).toEqual([])
    expect(e['status']).toBe('medido')
    const nomes = (e['licencas'].emAtencao as Array<{ nome: string; licenca: string }>).map(
      (i) => i.nome
    )
    expect(nomes).toContain(`${'n'.repeat(198)}${EMOJI}…`)
    expect(nomes).toContain('solto�')
    // O que o banco guardou, lido pelo próprio Postgres, não tem escape de surrogate solto.
    const cru = psql(
      dbUrl,
      `SELECT estado::text FROM repo_items WHERE project_id = '${p.projectId}' AND tipo = 'conformidade'`
    )
    expect(cru).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i)
  })

  describe('a credencial nunca chega à ficha, ao painel nem ao log', () => {
    const SENTINELA = 'ghp_SENTINELA0123456789abcdefghijklmnopqr'
    const OPACO = 'segredo-opaco-sem-prefixo-conhecido-9f3a'
    const casos: Array<{ rotulo: string; token: string; mensagem: string; proibidos: string[] }> = [
      {
        rotulo: 'header Authorization na mensagem',
        token: SENTINELA,
        mensagem: `socket hang up (Authorization: Bearer ${SENTINELA})`,
        proibidos: [SENTINELA],
      },
      {
        rotulo: 'só o token na mensagem',
        token: SENTINELA,
        mensagem: `ECONNRESET ao enviar ${SENTINELA} para o host`,
        proibidos: [SENTINELA],
      },
      {
        rotulo: 'token sem formato reconhecível, só conhecido pela etapa',
        token: OPACO,
        mensagem: `proxy recusou a credencial ${OPACO} no túnel`,
        proibidos: [OPACO],
      },
      {
        rotulo: 'header com token que a etapa não conhece',
        token: SENTINELA,
        mensagem:
          'request failed {"headers":{"authorization":"token ghs_OUTROTOKEN0123456789abcdefghijklmnop"}}',
        proibidos: ['OUTROTOKEN'],
      },
    ]

    it.each(casos)(
      'erro de rede só no SBOM ($rotulo): a ficha, os eventos e os logs ficam limpos',
      async ({ token, mensagem, proibidos }) => {
        const p = await novoProjeto('vazamento')
        const { fetchLocal } = await iniciarGitHub({ [p.wingId]: PRIVADO_PLANO_GRATIS })
        const fetchQueFalhaNoSbom: typeof fetch = (input, init) => {
          if (String(input).includes('/dependency-graph/sbom')) {
            return Promise.reject(new Error(mensagem))
          }
          return fetchLocal(input, init)
        }
        const avisos: string[] = []
        const infos: string[] = []
        await passar({
          projetos: [p],
          fetchLocal: fetchQueFalhaNoSbom,
          credenciais: [{ origem: 'cliente ou dono', token }],
          avisos,
          infos,
        })

        const e = estadoDe(await ficha(p.projectId, 'conformidade'))
        expect(e['licencas'].estado).toBe('nao-verificado')
        expect(e['licencas'].motivo).toContain('falha ao ler o SBOM')

        const fichas = psql(
          dbUrl,
          `SELECT estado::text FROM repo_items WHERE project_id = '${p.projectId}'`
        )
        const eventos = psql(
          dbUrl,
          `SELECT payload::text FROM events WHERE project_id = '${p.projectId}'`
        )
        const tudo = [fichas, eventos, ...avisos, ...infos].join('\n')
        for (const proibido of proibidos) expect(tudo).not.toContain(proibido)
        expect(tudo).not.toMatch(/Bearer\s+\S|authorization"?\s*:\s*"?token\s+\S/i)
      }
    )
  })

  it('lista de licenças em atenção por projeto (runtime_config) troca o padrão', async () => {
    const p = await novoProjeto('privado', { licencasEmAtencao: ['LGPL'] })
    const { fetchLocal } = await iniciarGitHub({
      [p.wingId]: PRIVADO_PLANO_GRATIS,
    })
    // o projeto vem do banco como o scheduler o lê
    const [lido] = await prisma.project.findMany({
      where: { id: p.projectId },
      select: { id: true, wingId: true, runtimeConfig: true },
    })
    await passar({ projetos: [lido as ProjetoDaSeguranca], fetchLocal })
    const e = estadoDe(await ficha(p.projectId, 'conformidade'))
    expect(e['licencas'].listaUsada).toEqual(['LGPL'])
    expect(e['licencas'].emAtencao).toEqual([{ nome: 'fraca', licenca: 'LGPL-3.0-or-later' }])
  })

  it('indícios de PII: informativos, contados, no máximo 3 blobs, e fora dos problemas', async () => {
    const p = await novoProjeto('pii')
    const arquivos: Record<string, string> = {
      'prisma/schema.prisma': 'model Usuario {\n  email String\n  cpf String\n}',
    }
    for (let i = 0; i < 6; i += 1) {
      arquivos[`prisma/migrations/2026010${i}_m/migration.sql`] = `ALTER TABLE t ADD email text;`
    }
    const { github, fetchLocal } = await iniciarGitHub({
      [p.wingId]: {
        ...PRIVADO_PLANO_GRATIS,
        arquivos: { ...PRIVADO_PLANO_GRATIS.arquivos, ...arquivos },
      },
    })
    await passar({ projetos: [p], fetchLocal })
    expect(github.chamadas.filter((c) => c.includes('/git/blobs/'))).toHaveLength(3)
    const e = estadoDe(await ficha(p.projectId, 'conformidade'))
    expect(e['indiciosDePii'].estado).toBe('verificado')
    expect(e['indiciosDePii'].arquivosLidos).toHaveLength(3)
    expect(e['indiciosDePii'].indicios).toEqual(
      expect.arrayContaining([{ padrao: 'e-mail', ocorrencias: 3, arquivos: 3 }])
    )
    expect((e['problemas'] as string[]).some((x) => x.includes('pii') || x.includes('email'))).toBe(
      false
    )
  })
})
