import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Prisma, PrismaClient } from '@prisma/client'
import { telegramPlugin } from '../src/plugins/telegram.js'
import {
  buscarTarefaParecidaDosPrs,
  type DepsDaBuscaDeTarefaParecida,
} from '../src/services/busca-de-tarefa-parecida.js'
import { carregarIssuePorPr } from '../src/services/issue-por-pr-do-vigia.js'
import { issueConfiavelDaFicha } from '../src/services/origem-do-item.js'
import { lancarErroDoGitHub, limparFreiosDeCota } from '../src/services/freio-de-cota-do-github.js'
import { sendTelegramQuestion } from '../src/services/telegram-bot.js'
import type { AgentQuestionService } from '../src/services/agent-question.js'
import type { EngineConnectionService } from '../src/services/engine-connection.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui: a
// ligação só prova alguma coisa contra um Postgres de verdade.
vi.unmock('@prisma/client')

/**
 * A missão do RA procurando a tarefa de um pull request pelo código, e o PO
 * perguntando ao dono quando o analista não acha. O que está em jogo, contra o
 * banco real:
 *
 *  - o motor de IA é FALSO (não pode ser real em CI), mas o formulário passa
 *    pelo RAILS_SCHEMAS e pelo runFormStep de verdade;
 *  - o GitHub é um servidor HTTP local (a leitura sai pela rede de verdade);
 *  - a pergunta é o AgentQuestionService real, registrado pelo plugin do
 *    Telegram, com o Telegram FALSO (o envio é interceptado no fetch);
 *  - a resposta do dono passa pelo tratador REAL registrado no plugin.
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

interface ConfigDoGitHub {
  prs: Array<{ number: number; title?: string; sha: string }>
  issues: Array<{ number: number; title: string }>
  /** Issues que o GET /issues/N encontra abertas (para o texto livre do dono). */
  issuesLidasUmaAUma?: number[]
}

/** O GitHub de mentira: PRs e issues abertos, arquivos do PR e leitura de uma issue. */
function githubLocal(config: ConfigDoGitHub) {
  const requisicoes: string[] = []
  const servidor: Server = createServer((req, res) => {
    const caminho = req.url ?? ''
    requisicoes.push(`${req.method} ${caminho}`)
    const json = (corpo: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(corpo))
    }
    if (caminho.startsWith(`/repos/${REPO}/pulls?state=open`)) {
      return json(
        config.prs.map((p) => ({
          number: p.number,
          title: p.title ?? `PR ${p.number}`,
          state: 'open',
          head: { sha: p.sha },
        }))
      )
    }
    if (caminho.startsWith(`/repos/${REPO}/issues?state=open`)) {
      return json(config.issues.map((i) => ({ number: i.number, title: i.title, state: 'open' })))
    }
    const arquivos = /^\/repos\/o\/r\/pulls\/(\d+)\/files/.exec(caminho)
    if (arquivos) {
      return json([
        {
          filename: 'src/wishlist.ts',
          status: 'modified',
          additions: 4,
          deletions: 1,
          patch: '@@ -1,2 +1,5 @@\n+adiciona o pedido',
        },
      ])
    }
    const umaIssue = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(caminho)
    if (umaIssue && config.issuesLidasUmaAUma?.includes(Number(umaIssue[1]))) {
      return json({ number: Number(umaIssue[1]), state: 'open' })
    }
    res.writeHead(404)
    res.end('{}')
  })
  return { servidor, requisicoes }
}

describe.skipIf(!reachable)('busca da tarefa pelo código e pergunta ao dono (integration)', () => {
  const dbName = `gitorch_it_ligacao_busca_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  let dbUrl = ''
  let prisma: PrismaClient
  let servidor: Server | null = null
  let base = ''
  let app: FastifyInstance | null = null
  const fetchOriginal = globalThis.fetch
  const mensagensDoTelegram: Array<{ url: string; corpo: Record<string, unknown> }> = []
  const envOriginal: Record<string, string | undefined> = {}

  beforeAll(async () => {
    psql(requireAdminUrl(), `CREATE DATABASE "${dbName}"`)
    dbUrl = withDatabase(requireAdminUrl(), dbName)
    applySchema(dbUrl)
    const { PrismaClient: PrismaDeVerdade } = await import('@prisma/client')
    prisma = new PrismaDeVerdade({ datasources: { db: { url: dbUrl } } })
  }, 120_000)

  beforeEach(() => {
    limparFreiosDeCota()
    mensagensDoTelegram.length = 0
    for (const chave of ['GITORCH_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']) {
      envOriginal[chave] = process.env[chave]
    }
    delete process.env['TELEGRAM_BOT_TOKEN']
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'token-falso-do-telegram'
  })

  afterEach(async () => {
    globalThis.fetch = fetchOriginal
    if (app) await app.close()
    app = null
    if (servidor) await new Promise<void>((resolve) => servidor!.close(() => resolve()))
    servidor = null
    for (const chave of Object.keys(envOriginal)) {
      if (envOriginal[chave] === undefined) delete process.env[chave]
      else process.env[chave] = envOriginal[chave]
    }
    limparFreiosDeCota()
  })

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  })

  /** Projeto com dono e chat do Telegram vinculado (para a notificação sair). */
  async function novoProjeto(runtimeConfig: Prisma.InputJsonValue | null = null) {
    const projectId = randomUUID()
    await prisma.plan.upsert({
      where: { id: 'free' },
      update: {},
      create: { id: 'free', name: 'free', maxProjects: 1, maxMissionsPerDay: 1 },
    })
    const dono = await prisma.user.create({
      data: { email: `${randomUUID()}@teste.local`, planId: 'free' },
    })
    const userId = dono.id
    await prisma.telegramLink.create({
      data: { userId, status: 'linked', chatId: 'chat-do-dono' },
    })
    await prisma.project.create({
      data: {
        id: projectId,
        wingId: REPO,
        name: `repo-${projectId}`,
        userId,
        ...(runtimeConfig !== null ? { runtimeConfig } : {}),
      },
    })
    return { projectId, userId }
  }

  async function semearPr(
    projectId: string,
    numero: number,
    origem: string | null = 'assistente',
    status = 'open'
  ) {
    await prisma.repoItem.create({
      data: { projectId, tipo: 'pr', numero, estado: { status }, origem },
    })
  }

  async function ficha(projectId: string, numero: number) {
    const linha = await prisma.repoItem.findUniqueOrThrow({
      where: { projectId_tipo_numero: { projectId, tipo: 'pr', numero } },
    })
    return { issue: linha.issueNumber, vinculoOrigem: linha.vinculoOrigem, origem: linha.origem }
  }

  /** Sobe o GitHub local, o Telegram falso e o plugin do Telegram (serviço de perguntas real). */
  async function iniciar(config: ConfigDoGitHub) {
    const github = githubLocal(config)
    servidor = github.servidor
    await new Promise<void>((resolve) => servidor!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://api.telegram.org/')) {
        mensagensDoTelegram.push({
          url,
          corpo: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
          status: 200,
        })
      }
      if (url.startsWith('https://api.github.com')) {
        return fetchOriginal(url.replace('https://api.github.com', base), init)
      }
      return fetchOriginal(input, init)
    }) as typeof fetch

    const fastify = Fastify({ logger: false })
    fastify.decorate('prisma', prisma)
    fastify.decorate('engineConnections', {
      getRawGithubToken: async () => 'token-do-dono',
    } as unknown as EngineConnectionService)
    await fastify.register(telegramPlugin)
    app = fastify
    const perguntas = fastify.agentQuestionService
    if (!perguntas) throw new Error('o plugin do Telegram não decorou o serviço de perguntas')
    return { github, perguntas }
  }

  /** O motor FALSO: devolve o que o teste mandar; o formulário é validado de verdade. */
  function motorFalso(
    resposta: () => { issueNumberEncontrado: number | null; justificativa: string }
  ) {
    return vi.fn(async (_prompt: string) => JSON.stringify(resposta()))
  }

  /** Uma missão do RA (a parte que esta peça faz), montada como o scheduler a monta. */
  function missao(args: {
    projectId: string
    userId: string
    execute: DepsDaBuscaDeTarefaParecida['execute']
    perguntas: AgentQuestionService
    runtimeConfig?: unknown
    avisos?: string[]
  }) {
    return buscarTarefaParecidaDosPrs({
      prisma,
      projectId: args.projectId,
      repo: REPO,
      userId: args.userId,
      runtimeConfig: args.runtimeConfig ?? null,
      contextBlocks: ['contexto do RA'],
      execute: args.execute,
      ghGet: async (caminho) => {
        const resposta = await fetch(`${base}${caminho}`)
        if (!resposta.ok) {
          lancarErroDoGitHub(`GitHub GET ${caminho} failed (${resposta.status})`, resposta, caminho)
        }
        return resposta.json()
      },
      agentQuestion: args.perguntas,
      onWarn: (m) => args.avisos?.push(m),
    })
  }

  const ISSUES = [
    { number: 713, title: '/wishlist add responde confirmação mas não registra o pedido' },
    { number: 30, title: 'Outra tarefa' },
    { number: 47, title: 'Mais uma tarefa' },
  ]

  function perguntasDoProjeto(projectId: string) {
    return prisma.agentQuestion.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })
  }

  it('acha a issue válida: grava issue_number com vinculo_origem "codigo" e registra no painel, sem perguntar', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({
      prs: [{ number: 590, sha: 'abc123' }],
      issues: ISSUES,
    })
    const execute = motorFalso(() => ({
      issueNumberEncontrado: 713,
      justificativa: 'o diff mexe no /wishlist add',
    }))

    const r = await missao({ projectId, userId, execute, perguntas })

    expect(r.vinculados).toEqual([{ pr: 590, issue: 713 }])
    expect(await ficha(projectId, 590)).toEqual({
      issue: 713,
      vinculoOrigem: 'codigo',
      origem: 'assistente',
    })
    const chaves = psql(
      dbUrl,
      `SELECT payload->>'chave' FROM events WHERE project_id = '${projectId}' AND type = 'audit'`
    )
    expect(chaves).toBe(`vinculo-ra:${REPO}:590:abc123`)
    expect(await perguntasDoProjeto(projectId)).toHaveLength(0)
    // O prompt que o motor recebeu leva a lista de issues abertas.
    expect(execute.mock.calls[0]![0]).toContain('#713')
  })

  it('o palpite "codigo" NÃO vira tarefa do vigia (issueConfiavelDaFicha e carregarIssuePorPr o ignoram)', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: 713, justificativa: 'sim' })),
    })

    const linha = await prisma.repoItem.findUniqueOrThrow({
      where: { projectId_tipo_numero: { projectId, tipo: 'pr', numero: 590 } },
    })
    expect(linha.issueNumber).toBe(713)
    expect(issueConfiavelDaFicha(linha)).toBeNull()
    const doVigia = await carregarIssuePorPr(prisma, projectId)
    expect(doVigia.issuePorPr.has(590)).toBe(false)
  })

  it('issue FORA da lista: tratada como null; nada é gravado e o dono recebe a pergunta (Telegram e painel)', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    const execute = motorFalso(() => ({ issueNumberEncontrado: 9999, justificativa: 'inventei' }))

    const r = await missao({ projectId, userId, execute, perguntas })

    expect(r.vinculados).toEqual([])
    expect(await ficha(projectId, 590)).toMatchObject({ issue: null, vinculoOrigem: null })

    const abertas = await perguntasDoProjeto(projectId)
    expect(abertas).toHaveLength(1)
    expect(abertas[0]).toMatchObject({
      status: 'open',
      dedupKey: `vinculo-da-tarefa:${REPO}:590`,
      userId,
    })
    // As 2 tarefas abertas mais recentes + "nenhuma destas" + resposta livre.
    expect((abertas[0]!.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'vinculo-issue-713',
      'vinculo-issue-47',
      'nenhuma-destas',
      '__gitorch_free_text__',
    ])
    // Painel: o evento da pergunta existe.
    expect(
      psql(
        dbUrl,
        `SELECT count(*) FROM events WHERE project_id = '${projectId}' AND type = 'agent_question'`
      )
    ).toBe('1')
    // Telegram (falso): a mensagem saiu para o chat do dono, com os 4 botões.
    expect(mensagensDoTelegram).toHaveLength(1)
    expect(mensagensDoTelegram[0]!.corpo['chat_id']).toBe('chat-do-dono')
    const teclado = mensagensDoTelegram[0]!.corpo['reply_markup'] as {
      inline_keyboard: Array<Array<{ text: string }>>
    }
    expect(teclado.inline_keyboard.flat()).toHaveLength(4)
  })

  it('a mesma pergunta aberta não se repete: chamar a missão duas vezes (e com head novo) deixa UMA pergunta', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'h1' }], issues: ISSUES })
    const execute = motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' }))

    await missao({ projectId, userId, execute, perguntas })
    await missao({ projectId, userId, execute, perguntas })
    expect(execute).toHaveBeenCalledTimes(1)

    // Um push novo: o analista tenta de novo, mas a pergunta aberta vale.
    if (servidor) await new Promise<void>((resolve) => servidor!.close(() => resolve()))
    const novo = githubLocal({ prs: [{ number: 590, sha: 'h2' }], issues: ISSUES })
    servidor = novo.servidor
    await new Promise<void>((resolve) => servidor!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`
    await missao({ projectId, userId, execute, perguntas })

    expect(execute).toHaveBeenCalledTimes(2)
    expect(await perguntasDoProjeto(projectId)).toHaveLength(1)
    expect(mensagensDoTelegram).toHaveLength(1)
  })

  it('o dono clica na candidata (vinculo-issue-713): o tratador real grava issue_number=713 com vinculo_origem "dono"', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' })),
    })
    const [pergunta] = await perguntasDoProjeto(projectId)

    await perguntas.answer(pergunta!.id, 'vinculo-issue-713', 'telegram')

    expect(await ficha(projectId, 590)).toMatchObject({ issue: 713, vinculoOrigem: 'dono' })
    // A confirmação do dono vale como tarefa do vigia.
    const doVigia = await carregarIssuePorPr(prisma, projectId)
    // (origem "assistente" é conhecida: a régua de origem deixa passar)
    expect(doVigia.issuePorPr.get(590)).toBe(713)
    // Responder de novo é inofensivo.
    await perguntas.answer(pergunta!.id, 'vinculo-issue-713', 'telegram')
    expect(await ficha(projectId, 590)).toMatchObject({ issue: 713, vinculoOrigem: 'dono' })
  })

  it.each(['formal', 'texto', 'dono'])(
    'vínculo já gravado com origem confiável (%s): a resposta do dono NÃO o sobrescreve',
    async (origemDoVinculo) => {
      const { projectId, userId } = await novoProjeto()
      await semearPr(projectId, 590)
      await prisma.repoItem.update({
        where: { projectId_tipo_numero: { projectId, tipo: 'pr', numero: 590 } },
        data: { issueNumber: 30, vinculoOrigem: origemDoVinculo },
      })
      const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
      const { question } = (await perguntas.ask(userId, projectId, {
        text: 'a qual tarefa pertence?',
        options: [{ label: '#713', value: 'vinculo-issue-713' }],
        dedupKey: `vinculo-da-tarefa:${REPO}:590`,
      })) as { question: { id: string } }

      await perguntas.answer(question.id, 'vinculo-issue-713', 'panel')

      expect(await ficha(projectId, 590)).toMatchObject({
        issue: 30,
        vinculoOrigem: origemDoVinculo,
      })
    }
  )

  it('resposta livre e o GitHub fora do ar: não grava e o erro fica no log, não some', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' })),
    })
    const [pergunta] = await perguntasDoProjeto(projectId)
    const aviso = vi.spyOn(app!.log, 'warn')
    // A conferência da tarefa sai para o GitHub; derrubado o servidor, a rede falha.
    await new Promise<void>((resolve) => servidor!.close(() => resolve()))
    servidor = null

    await perguntas.answer(pergunta!.id, 'é a #713', 'panel')

    expect(await ficha(projectId, 590)).toMatchObject({ issue: null, vinculoOrigem: null })
    expect(
      aviso.mock.calls.some((c) =>
        c.some((a) => String(a).includes('não consegui conferir a tarefa #713'))
      )
    ).toBe(true)
  })

  it('"nenhuma destas": nada muda na ficha e a pergunta não volta', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    const execute = motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' }))
    await missao({ projectId, userId, execute, perguntas })
    const [pergunta] = await perguntasDoProjeto(projectId)

    await perguntas.answer(pergunta!.id, 'nenhuma-destas', 'telegram')
    await missao({ projectId, userId, execute, perguntas })

    expect(await ficha(projectId, 590)).toMatchObject({ issue: null, vinculoOrigem: null })
    const todas = await perguntasDoProjeto(projectId)
    expect(todas).toHaveLength(1)
    expect(todas[0]!.status).toBe('answered')
    expect(mensagensDoTelegram).toHaveLength(1)
  })

  it('resposta livre "#713": confere no GitHub que é issue aberta e grava como "dono"', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({
      prs: [{ number: 590, sha: 'abc' }],
      issues: ISSUES,
      issuesLidasUmaAUma: [713],
    })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' })),
    })
    const [pergunta] = await perguntasDoProjeto(projectId)

    await perguntas.answer(pergunta!.id, 'é a tarefa #713', 'panel')

    expect(await ficha(projectId, 590)).toMatchObject({ issue: 713, vinculoOrigem: 'dono' })
  })

  it('resposta livre com issue que não está aberta: não grava e deixa o registro no painel', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({
      prs: [{ number: 590, sha: 'abc' }],
      issues: ISSUES,
      issuesLidasUmaAUma: [],
    })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' })),
    })
    const [pergunta] = await perguntasDoProjeto(projectId)

    await perguntas.answer(pergunta!.id, '#9999', 'panel')

    expect(await ficha(projectId, 590)).toMatchObject({ issue: null, vinculoOrigem: null })
    const registros = psql(
      dbUrl,
      `SELECT count(*) FROM events WHERE project_id = '${projectId}' AND type = 'audit' ` +
        `AND payload->>'chave' LIKE 'vinculo-resposta:%'`
    )
    expect(registros).toBe('1')
  })

  it('o dono confirma um palpite "codigo" com a mesma pergunta: o vínculo passa a "dono"', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: 713, justificativa: 'sim' })),
    })
    expect(await ficha(projectId, 590)).toMatchObject({ issue: 713, vinculoOrigem: 'codigo' })

    const { question } = (await perguntas.ask(userId, projectId, {
      text: 'confirma?',
      options: [{ label: '#713', value: 'vinculo-issue-713' }],
      dedupKey: `vinculo-da-tarefa:${REPO}:590`,
    })) as { question: { id: string } }
    await perguntas.answer(question.id, 'vinculo-issue-713', 'panel')

    expect(await ficha(projectId, 590)).toMatchObject({ issue: 713, vinculoOrigem: 'dono' })
  })

  it('origem dependabot/outro_bot e política "nao" não gastam motor nem perguntam', async () => {
    const { projectId, userId } = await novoProjeto({ cuidaPorOrigem: { pessoa: 'nao' } })
    await semearPr(projectId, 1, 'dependabot')
    await semearPr(projectId, 2, 'outro_bot')
    await semearPr(projectId, 3, 'pessoa')
    const { perguntas, github } = await iniciar({
      prs: [
        { number: 1, sha: 'a' },
        { number: 2, sha: 'b' },
        { number: 3, sha: 'c' },
      ],
      issues: ISSUES,
    })
    const execute = motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' }))

    await missao({
      projectId,
      userId,
      perguntas,
      execute,
      runtimeConfig: { cuidaPorOrigem: { pessoa: 'nao' } },
    })

    expect(execute).not.toHaveBeenCalled()
    expect(github.requisicoes).toEqual([])
    expect(await perguntasDoProjeto(projectId)).toHaveLength(0)
  })

  it('o teto de 2 perguntas por missão vale no banco real; a terceira sai na missão seguinte', async () => {
    const { projectId, userId } = await novoProjeto()
    for (const n of [11, 12, 13]) await semearPr(projectId, n)
    const { perguntas } = await iniciar({
      prs: [11, 12, 13].map((n) => ({ number: n, sha: `s${n}` })),
      issues: ISSUES,
    })
    const execute = motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' }))

    await missao({ projectId, userId, perguntas, execute })
    expect(await perguntasDoProjeto(projectId)).toHaveLength(2)

    await missao({ projectId, userId, perguntas, execute })
    expect(await perguntasDoProjeto(projectId)).toHaveLength(3)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('a pergunta que sai passa pelo envio do Telegram sem ser recusada (no máximo 3 opções objetivas)', async () => {
    const { projectId, userId } = await novoProjeto()
    await semearPr(projectId, 590)
    const { perguntas } = await iniciar({ prs: [{ number: 590, sha: 'abc' }], issues: ISSUES })
    await missao({
      projectId,
      userId,
      perguntas,
      execute: motorFalso(() => ({ issueNumberEncontrado: null, justificativa: 'nada' })),
    })
    const [pergunta] = await perguntasDoProjeto(projectId)

    const enviadas: unknown[] = []
    await expect(
      sendTelegramQuestion({
        botToken: 'falso',
        chatId: 'c',
        questionId: pergunta!.id,
        text: pergunta!.text,
        options: pergunta!.options as Array<{ label: string; value: string }>,
        fetchImpl: (async (_url: unknown, init?: RequestInit) => {
          enviadas.push(init?.body)
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
            status: 200,
          })
        }) as typeof fetch,
      })
    ).resolves.toBe(1)
    expect(enviadas).toHaveLength(1)
  })
})
