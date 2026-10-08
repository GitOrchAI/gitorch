import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import {
  aplicarMelhoriasDeSegurancaDosProjetos,
  desfazerMelhoriaDoProjeto,
  type ProjetoParaAplicar,
} from '../src/services/aplicador-de-seguranca-dos-projetos.js'
import { criarRitmoDeEscrita } from '../src/services/escritor-de-seguranca.js'
import { fetchDoRepositorio } from '../src/services/guarda-de-autonomia.js'
import { limparFreiosDeCota } from '../src/services/freio-de-cota-do-github.js'
import { AgentQuestionService } from '../src/services/agent-question.js'
import {
  GitHubDeMelhoriasFalso,
  type ConfiguracaoDoRepositorioFalso,
} from '../src/test/github-de-melhorias-fake.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui.
vi.unmock('@prisma/client')

/**
 * A aplicação das melhorias de segurança, de ponta a ponta: banco real
 * (fichas, painel, perguntas ao dono) e um GitHub de mentira com ESTADO atrás de
 * um servidor HTTP local que REGISTRA toda requisição. Nenhuma escrita sai para
 * o GitHub de verdade, e nenhuma mensagem real é enviada ao dono.
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

const TOKEN_DO_CLIENTE = 'ghp_sentinela_integracao_cliente_0000'
const TOKEN_DO_APP = 'ghs_sentinela_integracao_app_00000000'
const INTERVALO = 60_000

const CI = [
  'name: ci',
  'on: push',
  '',
  'jobs:',
  '  t:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: actions/checkout@${'a'.repeat(40)}`,
  '      - run: npm test',
  '',
].join('\n')

describe.skipIf(!reachable)('aplicação das melhorias de segurança (integration)', () => {
  const dbName = `gitorch_it_aplicar_seguranca_${randomUUID().replace(/-/g, '').slice(0, 16)}`
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

  async function novoProjeto(
    rotulo: string,
    niveis: { autonomia?: string; seguranca?: string } = {}
  ): Promise<ProjetoParaAplicar> {
    contador += 1
    const id = randomUUID()
    const wingId = `acme/${rotulo}-${contador}`
    psql(
      dbUrl,
      `INSERT INTO projects (id, wing_id, name, autonomia, autonomia_de_seguranca, updated_at) ` +
        `VALUES ('${id}', '${wingId}', '${wingId}', '${niveis.autonomia ?? 'cuidar'}', ` +
        `'${niveis.seguranca ?? 'cuidar'}', now())`
    )
    return {
      id,
      wingId,
      userId: 'dono-1',
      autonomia: niveis.autonomia ?? 'cuidar',
      autonomiaDeSeguranca: niveis.seguranca ?? 'cuidar',
    }
  }

  /** O GitHub de mentira atrás de HTTP real; a hora do teste anda quando o ritmo espera. */
  async function iniciarGitHub(repositorio: string, config: ConfiguracaoDoRepositorioFalso = {}) {
    let t = Date.parse('2026-03-10T12:00:00.000Z')
    const github = new GitHubDeMelhoriasFalso(repositorio, {
      privado: false,
      segredos: 'disabled',
      bloqueioDePush: 'disabled',
      alertasDeDependencias: false,
      atualizacoesDeSeguranca: false,
      varreduraDeCodigo: 'not-configured',
      linguagens: { TypeScript: 10 },
      permissaoDoWorkflow: 'write',
      podeAprovarPrs: false,
      arquivos: { '.github/workflows/ci.yml': CI },
      ...config,
    })
    github.usarRelogio(() => t)
    servidor = createServer((req, res) => {
      github.atenderHttp(req, res).catch(() => {
        res.writeHead(500)
        res.end()
      })
    })
    await new Promise<void>((resolve) => servidor!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`
    const fetchLocal: typeof fetch = (input, init) =>
      fetch(String(input).replace('https://api.github.com', `${base}/api`), init)
    return {
      github,
      fetchLocal,
      avancar: (ms: number) => {
        t += ms
      },
      agora: () => t,
      ritmo: criarRitmoDeEscrita({
        esperar: async (ms) => {
          t += ms
        },
        agora: () => t,
      }),
    }
  }

  type Mundo = Awaited<ReturnType<typeof iniciarGitHub>>

  function passada(
    mundo: Mundo,
    projeto: ProjetoParaAplicar,
    extra: {
      env?: Record<string, string | undefined>
      perguntas?: AgentQuestionService | null
      avisos?: string[]
      infos?: string[]
    } = {}
  ) {
    return aplicarMelhoriasDeSegurancaDosProjetos({
      prisma,
      projetos: [projeto],
      agora: () => new Date(mundo.agora()),
      credenciais: async () => [
        { origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE },
        { origem: 'App do produto', token: TOKEN_DO_APP },
      ],
      tokenDoApp: async () => TOKEN_DO_APP,
      fetchDeLeitura: mundo.fetchLocal,
      fetchDeEscrita: (p) =>
        fetchDoRepositorio({ nivel: () => p.autonomia, fetchImpl: mundo.fetchLocal }),
      ritmo: mundo.ritmo,
      agentQuestion: extra.perguntas === undefined ? null : extra.perguntas,
      env: extra.env ?? {},
      intervaloMs: INTERVALO,
      onInfo: (m) => extra.infos?.push(m),
      onWarn: (m) => extra.avisos?.push(m),
    })
  }

  async function passadas(mundo: Mundo, projeto: ProjetoParaAplicar, n: number, extra = {}) {
    for (let i = 0; i < n; i += 1) {
      await passada(mundo, projeto, extra)
      mundo.avancar(INTERVALO + 1000)
    }
  }

  const chavesDeEventos = (projectId: string): string[] => {
    const saida = psql(
      dbUrl,
      `SELECT payload->>'chave' FROM events WHERE project_id = '${projectId}' AND type = 'audit' ORDER BY created_at, 1`
    )
    return saida === '' ? [] : saida.split('\n')
  }

  const dumpDoProjeto = (projectId: string): string =>
    [
      psql(
        dbUrl,
        `SELECT coalesce(json_agg(r), '[]') FROM repo_items r WHERE project_id = '${projectId}'`
      ),
      psql(
        dbUrl,
        `SELECT coalesce(json_agg(e), '[]') FROM events e WHERE project_id = '${projectId}'`
      ),
      psql(
        dbUrl,
        `SELECT coalesce(json_agg(q), '[]') FROM agent_questions q WHERE project_id = '${projectId}'`
      ),
    ].join('\n')

  const ficha = (projectId: string, tipo: string): Record<string, unknown> | null => {
    const saida = psql(
      dbUrl,
      `SELECT estado FROM repo_items WHERE project_id = '${projectId}' AND tipo = '${tipo}' AND numero = 0`
    )
    return saida === '' ? null : (JSON.parse(saida) as Record<string, unknown>)
  }

  it('repositório público: aplica uma melhoria por passada, na ordem, e grava ficha, sondagem e painel', async () => {
    const projeto = await novoProjeto('publico')
    const mundo = await iniciarGitHub(projeto.wingId)
    const { github } = mundo

    const porPassada: string[][] = []
    for (let i = 0; i < 6; i += 1) {
      const antes = github.escritas().length
      await passada(mundo, projeto)
      mundo.avancar(INTERVALO + 1000)
      porPassada.push(
        github
          .escritas()
          .slice(antes)
          .map((e) => `${e.metodo} ${e.caminho.replace(`/repos/${projeto.wingId}`, '')}`)
      )
    }
    expect(porPassada).toEqual([
      ['PUT /vulnerability-alerts'],
      ['PUT /automated-security-fixes'],
      ['PATCH '],
      ['PATCH /code-scanning/default-setup'],
      ['POST /git/refs', 'PUT /contents/.github/workflows/ci.yml', 'POST /pulls'],
      [],
    ])

    // as escritas ficaram afastadas de pelo menos 1 s, em qualquer ponto
    const instantes = github.escritas().map((e) => e.em)
    for (let i = 1; i < instantes.length; i += 1) {
      expect(instantes[i]! - instantes[i - 1]!).toBeGreaterThanOrEqual(1000)
    }

    // o dono mescla o PR; o resto fecha sozinho e a permissão padrão do token vira "read" por último
    github.mesclarPull(1)
    await passadas(mundo, projeto, 4)
    expect(github.config.permissaoDoWorkflow).toBe('read')
    expect(github.escritas().at(-1)).toMatchObject({
      metodo: 'PUT',
      caminho: `/repos/${projeto.wingId}/actions/permissions/workflow`,
    })

    const melhorias = ficha(projeto.id, 'melhorias') as {
      melhorias: Record<string, { estado: string; anterior?: unknown; desfazer: string }>
    }
    expect(
      Object.fromEntries(Object.entries(melhorias.melhorias).map(([k, v]) => [k, v.estado]))
    ).toEqual({
      'alertas-de-dependencias': 'aplicado',
      'atualizacoes-de-seguranca': 'aplicado',
      'varredura-de-senhas': 'aplicado',
      'varredura-de-codigo': 'aplicado',
      'permissoes-minimas-dos-workflows:.github/workflows/ci.yml': 'aplicado',
      'permissao-padrao-do-workflow': 'aplicado',
    })
    expect(melhorias.melhorias['permissao-padrao-do-workflow']?.anterior).toEqual({
      permissao: 'write',
      podeAprovarPrs: false,
    })
    for (const m of Object.values(melhorias.melhorias)) expect(m.desfazer).toMatch(/Como desfazer/)

    const chaves = chavesDeEventos(projeto.id)
    for (const id of [
      'alertas-de-dependencias',
      'atualizacoes-de-seguranca',
      'varredura-de-senhas',
      'varredura-de-codigo',
      'permissao-padrao-do-workflow',
    ]) {
      expect(chaves).toContain(`melhoria-de-seguranca:${projeto.wingId}:${id}:aplicado`)
    }
    expect(chaves).toContain(
      `melhoria-de-seguranca:${projeto.wingId}:permissoes-minimas-dos-workflows:.github/workflows/ci.yml:aguardando-revisao`
    )
    expect(new Set(chaves).size).toBe(chaves.length)

    expect(ficha(projeto.id, 'sondagem')).toMatchObject({
      sondagem: { repositorio: projeto.wingId, comAdmin: true },
    })
  })

  it('reentrante: depois de tudo aplicado, mais passadas não escrevem, não repetem eventos e não releem a sondagem do dia', async () => {
    const projeto = await novoProjeto('reentrante')
    const mundo = await iniciarGitHub(projeto.wingId)
    const { github } = mundo
    await passadas(mundo, projeto, 6)
    github.mesclarPull(1)
    await passadas(mundo, projeto, 4)

    const escritas = github.escritas().length
    const eventos = chavesDeEventos(projeto.id).length
    const leituras = github.registro.length
    await passadas(mundo, projeto, 3)
    expect(github.escritas()).toHaveLength(escritas)
    expect(chavesDeEventos(projeto.id)).toHaveLength(eventos)
    // a sondagem do dia está no banco: as passadas ociosas não chamam o GitHub de novo
    expect(github.registro.length - leituras).toBe(0)
  })

  it('nenhum token (do cliente ou do App) em ficha, evento, pergunta ou aviso — caminho feliz e de erro; texto de fora cortado e sem substituto solto', async () => {
    const projeto = await novoProjeto('segredos')
    const avisos: string[] = []
    const infos: string[] = []
    const emojis = '😀'.repeat(4000)
    const mundo = await iniciarGitHub(projeto.wingId, {
      tokenDeAdmin: TOKEN_DO_APP,
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 422,
          mensagem: `recusado com Authorization: Bearer ${TOKEN_DO_CLIENTE} e ${TOKEN_DO_APP} ${emojis} \ud83d fim`,
        },
      },
    })
    await passadas(mundo, projeto, 4, { avisos, infos })

    const tudo = `${dumpDoProjeto(projeto.id)}\n${avisos.join('\n')}\n${infos.join('\n')}`
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
    // controle positivo: o erro foi para o painel (e o banco aceitou o texto)
    expect(chavesDeEventos(projeto.id)).toContain(
      `melhoria-de-seguranca:${projeto.wingId}:alertas-de-dependencias:recusado`
    )
    const texto = psql(
      dbUrl,
      `SELECT payload->>'texto' FROM events WHERE project_id = '${projeto.id}' AND payload->>'chave' LIKE '%alertas-de-dependencias:recusado'`
    )
    expect(texto).toContain('recusado com')
    expect(Array.from(texto).length).toBeLessThan(2000)
    // a leitura e a escrita usaram a credencial certa: o cliente leu primeiro, o App (admin) escreveu
    expect(mundo.github.registro[0]?.autorizacao).toBe(`Bearer ${TOKEN_DO_CLIENTE}`)
    expect(mundo.github.escritas().every((e) => e.autorizacao === `Bearer ${TOKEN_DO_APP}`)).toBe(
      true
    )
  })

  it.each([
    ['autonomia so_olhar', { autonomia: 'so_olhar' }],
    ['autonomia sugerir', { autonomia: 'sugerir' }],
    ['autonomia de segurança so_olhar', { seguranca: 'so_olhar' }],
    ['autonomia de segurança sugerir', { seguranca: 'sugerir' }],
  ])('%s: nenhuma requisição, nenhuma ficha, nenhum evento', async (_n, niveis) => {
    const projeto = await novoProjeto('barrado', niveis)
    const mundo = await iniciarGitHub(projeto.wingId)
    await passadas(mundo, projeto, 3)
    expect(mundo.github.registro).toEqual([])
    expect(ficha(projeto.id, 'melhorias')).toBeNull()
    expect(chavesDeEventos(projeto.id)).toEqual([])
  })

  it('interruptor desligado e projeto fora da lista: nada', async () => {
    const projeto = await novoProjeto('desligado')
    const mundo = await iniciarGitHub(projeto.wingId)
    await passadas(mundo, projeto, 2, { env: { GITORCH_APLICAR_SEGURANCA: 'off' } })
    await passadas(mundo, projeto, 2, { env: { GITORCH_APLICAR_SEGURANCA_EM: 'outro/repo' } })
    expect(mundo.github.registro).toEqual([])
  })

  it('privado em plano grátis: 403 vira "indisponível" e a alternativa gratuita sai por PR, nunca na branch padrão', async () => {
    const projeto = await novoProjeto('privado')
    const mundo = await iniciarGitHub(projeto.wingId, {
      privado: true,
      advancedSecurity: 'disabled',
    })
    await passadas(mundo, projeto, 6)
    const { github } = mundo
    const escritas = github
      .escritas()
      .map((e) => `${e.metodo} ${e.caminho.replace(`/repos/${projeto.wingId}`, '')}`)
    expect(escritas).toContain('PUT /vulnerability-alerts')
    expect(escritas).not.toContain('PATCH ')
    expect(escritas.filter((e) => e.startsWith('PUT /contents/'))).toHaveLength(2)
    for (const e of github.escritas().filter((x) => x.caminho.includes('/contents/'))) {
      expect((e.corpo as { branch?: string }).branch).toMatch(/^gitorch\/seguranca\//)
    }
    expect(
      github.arquivoNaPadrao('.github/workflows/gitorch-varredura-de-senhas.yml')
    ).toBeUndefined()
    expect(github.pulls.map((p) => p.head)).toContain(
      'gitorch/seguranca/alternativa-de-varredura-de-senhas'
    )
  })

  it('workflow de deploy intocado; a pergunta ao dono sai UMA vez pelo serviço real (3 objetivas + 1 aberta)', async () => {
    const projeto = await novoProjeto('deploy')
    const mundo = await iniciarGitHub(projeto.wingId, {
      arquivos: {
        '.github/workflows/ci.yml': CI,
        '.github/workflows/deploy.yml': CI.replace('name: ci', 'name: deploy'),
      },
    })
    // sem notificação: a pergunta existe no banco e no painel, nenhuma mensagem real sai
    const perguntas = new AgentQuestionService(prisma)
    await passadas(mundo, projeto, 8, { perguntas })

    const abertas = JSON.parse(
      psql(
        dbUrl,
        `SELECT coalesce(json_agg(q), '[]') FROM agent_questions q WHERE project_id = '${projeto.id}'`
      )
    ) as Array<{ status: string; dedup_key: string; options: Array<{ value: string }> }>
    expect(abertas).toHaveLength(1)
    expect(abertas[0]).toMatchObject({
      status: 'open',
      dedup_key: `seguranca-permissoes:${projeto.wingId}:.github/workflows/deploy.yml`,
    })
    expect(abertas[0]?.options).toHaveLength(4)
    expect(mundo.github.arquivoNaPadrao('.github/workflows/deploy.yml')).toContain('name: deploy')
    expect(mundo.github.escritas().some((e) => e.caminho.includes('deploy.yml'))).toBe(false)
    expect(mundo.github.config.permissaoDoWorkflow).toBe('write')

    // o dono responde "pode abrir": o PR do deploy sai, e só depois de mesclado o token muda
    psql(
      dbUrl,
      `UPDATE agent_questions SET status = 'answered', answer = 'permissoes-deploy-aplicar' WHERE project_id = '${projeto.id}'`
    )
    await passadas(mundo, projeto, 3, { perguntas })
    const prDoDeploy = mundo.github.pulls.find((p) => p.head.includes('deploy-yml'))
    expect(prDoDeploy).toBeDefined()
    expect(mundo.github.config.permissaoDoWorkflow).toBe('write')
  })

  it('desfazer pelo projeto restaura o estado anterior, marca "desfeito" e não é refeito pelas passadas seguintes', async () => {
    const projeto = await novoProjeto('desfaz')
    const mundo = await iniciarGitHub(projeto.wingId)
    await passadas(mundo, projeto, 1)
    expect(mundo.github.config.alertasDeDependencias).toBe(true)

    const r = await desfazerMelhoriaDoProjeto({
      prisma,
      projeto,
      melhoria: 'alertas-de-dependencias',
      credenciais: [{ origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE }],
      tokenDoApp: TOKEN_DO_APP,
      fetchDeLeitura: mundo.fetchLocal,
      fetchDeEscrita: fetchDoRepositorio({ nivel: () => 'cuidar', fetchImpl: mundo.fetchLocal }),
      ritmo: mundo.ritmo,
      agora: () => new Date(mundo.agora()),
    })
    expect(r.desfeito).toBe(true)
    expect(mundo.github.config.alertasDeDependencias).toBe(false)
    expect(chavesDeEventos(projeto.id)).toContain(
      `melhoria-de-seguranca:${projeto.wingId}:alertas-de-dependencias:desfeito`
    )
    await passadas(mundo, projeto, 3)
    expect(mundo.github.config.alertasDeDependencias).toBe(false)
  })
})
