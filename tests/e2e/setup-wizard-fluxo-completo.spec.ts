import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { EngineConnectionService } from '../../apps/control-plane/dist/services/engine-connection.js'

/**
 * E2E do FLUXO COMPLETO do setup wizard: submit -> projeto+missão no banco ->
 * painel do cliente -> status honesto do provisionamento -> isolamento entre
 * clientes. Roda contra o control-plane REAL (HTTP de verdade) e o Postgres
 * REAL (Prisma de verdade) — NADA da camada de dados é mockado.
 *
 * Existe porque a cobertura anterior provava apenas que as peças isoladas
 * repassavam argumentos entre mocks. Foi assim que estes bugs sobreviveram
 * meses, e é isto que este spec TRAVA:
 *   1. o painel cruzava o `wingId` da SESSÃO (login do GitHub, ex.: "acme") com
 *      o `wingId` do PROJETO ("acme/api" — o repositório): nunca casava, e o
 *      painel voltava VAZIO para sempre;
 *   2. o passo 11 pintava ✓ verde em ~0ms — perguntava "tem motor conectado?"
 *      (tautologia: a linha `github` nasce conectada no OAuth) em vez de olhar o
 *      provisionamento REAL;
 *   3. o mesmo repositório em dois clientes fazia o segundo HERDAR o projeto do
 *      primeiro (e ganhar uma ApiKey sobre ele).
 *
 * O QUE ESTE SPEC **NÃO** COBRE (honestidade — nenhuma destas pontas é
 * automatizável aqui, e fingir que são seria pior do que não testar):
 *
 * - **O login do GitHub (OAuth)**: exige um humano num navegador do GitHub. A
 *   sessão é FORJADA (JWT + cookie `gitorch_session`), exatamente como já fazem
 *   setup-wizard-diagnosis.spec.ts e setup-wizard-fechamento-robusto.spec.ts.
 *   Este spec NÃO prova que o login funciona — prova o que acontece DEPOIS dele.
 * - **O login assistido do motor (device login)**: exige aprovação humana no
 *   provider. O motor "conectado" aqui é uma linha REAL de EngineConnection com
 *   status 'connected' — exatamente o que o login assistido grava ao terminar.
 *   O caminho do login em si (liveness honesta, paste manual, SSE) é coberto por
 *   setup-wizard-fechamento-robusto.spec.ts com um CLI fake.
 * - **O clone real que o scheduler faz**: coberto por
 *   setup-wizard-diagnosis.spec.ts (clone de verdade da fixture). Aqui, quando o
 *   provisionamento precisa AVANÇAR (pending -> completed/failed), o estado é
 *   escrito na LINHA REAL da missão no Postgres — que é literalmente o que o
 *   scheduler faz (mission.update status/completedAt/error). Nada de mock.
 *
 * Sobre o scheduler REAL: ele roda a cada 60s no control-plane sob teste e é o
 * único outro escritor destas missões — ele reivindica (pending -> running)
 * qualquer `clone_and_start_engines` PENDENTE. Por isso as asserções
 * determinísticas deste spec são feitas sobre missões em estado TERMINAL
 * (completed/failed), que ele nunca toca (a consulta dele filtra
 * status:'pending'). Os repositórios aqui são inexistentes de propósito: se o
 * scheduler pegar uma missão pendente, o clone falha — nunca "conclui" sozinho,
 * então um ✓ verde jamais aparece por acidente.
 */

const BASE = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:4010'
const JWT_SECRET = process.env['JWT_SECRET'] ?? ''

// A missão que o submit enfileira — o provisionamento REAL do wizard.
const SETUP_MISSION = 'clone_and_start_engines'

// Prefixo de TODO dado criado por este spec; a limpeza apaga por ele.
const NS = 'e2e-fluxo'

const prisma = new PrismaClient()

interface Owner {
  id: string
  email: string
  /** Login do GitHub — é o `wingId` que vai no JWT da SESSÃO. */
  githubLogin: string
  session: string
}

interface SubmitResponse {
  success?: boolean
  error?: string
  projects?: Array<{ id: string; name: string; wingId: string; apiKey: string }>
}

interface MissionsResponse {
  missions: Array<{ id: string; type: string; status: string; error: string | null }>
  stats: { active: number; completed: number; failed: number }
}

interface SetupStatusResponse {
  status: string
  error: string | null
  missions: Array<{ projectId: string; wingId: string; status: string; error: string | null }>
  environment: { id: string; status: string } | null
}

/**
 * Cliente com sessão pronta. `engine` grava a EngineConnection REAL que o login
 * assistido gravaria ao final (ver cabeçalho) — sem ela o submit é (e deve ser)
 * recusado pelo gate anti-fachada.
 */
async function createOwner(slug: string, engine?: string): Promise<Owner> {
  const email = `${NS}-${slug}@gitorch.local`
  const githubLogin = `${NS}-${slug}`
  const user = await prisma.user.upsert({
    where: { email },
    update: { githubLogin },
    create: { email, githubLogin, planId: 'free' },
  })
  if (engine) {
    await prisma.engineConnection.create({
      data: { userId: user.id, runtime: engine, status: 'connected', lastValidatedAt: new Date() },
    })
  }

  // GitHub "conectado" com uma credencial de mentira. O passo final do cadastro
  // exige provar, com a credencial do PRÓPRIO cliente, que ele pode escrever no
  // repositório declarado — sem credencial nenhuma o produto recusa antes mesmo
  // de perguntar, e é o certo: "não sei" nunca pode virar "pode".
  //
  // O valor em si nunca importa aqui: este cenário roda com o fio de mentira da
  // prova ligado no workflow (as duas travas), então a pergunta nunca sai para o
  // GitHub de verdade. O que faltava era o cliente ter uma credencial.
  const engineConnections = new EngineConnectionService(prisma as never)
  await engineConnections.connectGitHubToken(user.id, `fake-github-token-${slug}`)
  // A sessão é forjada porque o OAuth do GitHub exige um humano (ver cabeçalho).
  // O `wingId` do JWT é o LOGIN — nunca o repositório: é essa distinção que o
  // painel confundia.
  const session = jwt.sign({ userId: user.id, wingId: githubLogin, email }, JWT_SECRET, {
    expiresIn: '30m',
  })
  return { id: user.id, email, githubLogin, session }
}

async function api<T>(
  owner: Owner,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Cookie: `gitorch_session=${owner.session}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as T }
  } catch {
    return { status: res.status, body: text as T }
  }
}

/** O aceite final do wizard: cria Project + ApiKey + a missão de provisionamento. */
async function submitWizard(
  owner: Owner,
  repo: string
): Promise<{ status: number; body: SubmitResponse }> {
  return api<SubmitResponse>(owner, 'POST', '/api/v1/setup/submit', {
    repos: [repo],
    engines: ['codex'],
    plan: 'free',
  })
}

function firstProject(res: { status: number; body: SubmitResponse }): {
  id: string
  wingId: string
} {
  expect(res.status, `submit recusado: ${JSON.stringify(res.body)}`).toBe(200)
  const project = res.body.projects?.[0]
  if (!project) throw new Error(`submit não devolveu projeto: ${JSON.stringify(res.body)}`)
  return project
}

/** Apaga tudo que este spec cria. Projeto cascateia missões/chaves/agendas; usuário cascateia motores/ambientes. */
async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  await prisma.project.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

test.beforeAll(async () => {
  // NÃO se auto-pula: um spec que se pula sozinho no CI não guarda nada. Estes
  // dois já existem no job do e2e-wizard.yml (JWT_SECRET é gerado efêmero lá).
  if (!JWT_SECRET) throw new Error('JWT_SECRET ausente — este E2E exige o control-plane real')
  if (!process.env['DATABASE_URL'])
    throw new Error('DATABASE_URL ausente — este E2E exige o Postgres real')
  await cleanup()
})

test.afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

test('painel: o dono enxerga a missão que o wizard acabou de criar', async () => {
  const dona = await createOwner('painel', 'codex')
  const repo = `${dona.githubLogin}/painel-do-cliente`

  const project = firstProject(await submitWizard(dona, repo))

  // O fixture É a regressão: o `wingId` do PROJETO é o repositório
  // ("owner/repo") e o `wingId` da SESSÃO é o login do GitHub ("owner"). Se um
  // dia alguém "consertar" este teste alinhando os dois, ele para de provar o
  // bug — por isso a diferença é asserida aqui.
  expect(project.wingId).toBe(repo)
  expect(project.wingId).toContain('/')
  expect(project.wingId).not.toBe(dona.githubLogin)

  // O submit criou trabalho REAL no banco — não um "ok" de fachada.
  const mission = await prisma.mission.findFirstOrThrow({
    where: { projectId: project.id, type: SETUP_MISSION },
  })

  // O CORAÇÃO DESTE SPEC. No código antigo o filtro era `project: { wingId }`
  // com o wingId da sessão: "e2e-fluxo-painel" nunca casa com
  // "e2e-fluxo-painel/painel-do-cliente" — e o painel voltava vazio PARA SEMPRE.
  const painel = await api<MissionsResponse>(dona, 'GET', '/api/missions')
  expect(painel.status).toBe(200)
  expect(
    painel.body.missions.map((m) => m.id),
    'painel VAZIO: o dono não vê a missão que o wizard acabou de criar para ele'
  ).toContain(mission.id)

  const { active, completed, failed } = painel.body.stats
  expect(
    active + completed + failed,
    'os contadores do painel também nasceram zerados'
  ).toBeGreaterThanOrEqual(1)
})

test('passo 11 não mente: pendente não vira ✓, concluído vira, e falha devolve a CAUSA', async () => {
  const cliente = await createOwner('status', 'codex')
  const repo = `${cliente.githubLogin}/provisionamento`
  const project = firstProject(await submitWizard(cliente, repo))
  const scope = `/api/v1/setup/status?projects=${project.id}`

  // 1) Recém-submetido: o provisionamento está PENDENTE. O passo 11 tem que
  // dizer isso — antes ele respondia "pronto" no primeiro poll (~0ms) porque só
  // perguntava se havia motor conectado.
  const pendente = await api<SetupStatusResponse>(cliente, 'GET', scope)
  expect(pendente.status).toBe(200)
  expect(
    pendente.body.status,
    'esperado "pending". Se veio running/failed, foi o scheduler REAL (tick de 60s) reivindicando a missão no meio do teste — corrida rara e conhecida (ver cabeçalho). O que NUNCA pode acontecer é "completed": o repo não existe.'
  ).toBe('pending')
  expect(pendente.body.status).not.toBe('completed')
  expect(pendente.body.missions).toHaveLength(1)
  expect(pendente.body.missions[0]?.projectId).toBe(project.id)
  expect(pendente.body.missions[0]?.wingId).toBe(repo)

  // 2) O provisionamento TERMINA BEM. Escrito na linha REAL da missão — é
  // exatamente o que o scheduler faz ao concluir (ver cabeçalho).
  await prisma.mission.updateMany({
    where: { projectId: project.id, type: SETUP_MISSION },
    data: { status: 'completed', completedAt: new Date() },
  })
  const pronto = await api<SetupStatusResponse>(cliente, 'GET', scope)
  expect(pronto.body.status, 'concluído de verdade e o passo 11 não reconhece').toBe('completed')
  expect(pronto.body.error).toBeNull()

  // 3) O provisionamento FALHA: o cliente merece a causa REAL, nunca um "ops".
  const causa = 'clone falhou: repositório não encontrado (E2E)'
  await prisma.mission.updateMany({
    where: { projectId: project.id, type: SETUP_MISSION },
    data: { status: 'failed', error: causa },
  })
  const falhou = await api<SetupStatusResponse>(cliente, 'GET', scope)
  expect(falhou.body.status).toBe('failed')
  expect(falhou.body.error, 'a falha chegou ao cliente sem a causa').toBe(causa)
  expect(falhou.body.missions[0]?.error).toBe(causa)

  // 4) Retentar cria trabalho NOVO (não ressuscita a missão morta, que o
  // sweeper do scheduler mataria de novo na hora).
  const retry = await api<{ retried: number }>(cliente, 'POST', '/api/v1/setup/retry', {
    projects: [project.id],
  })
  expect(retry.status).toBe(200)
  expect(retry.body.retried).toBe(1)
  expect(
    await prisma.mission.count({ where: { projectId: project.id, type: SETUP_MISSION } }),
    'a retentativa não enfileirou uma missão nova'
  ).toBe(2)
})

test('isolamento: o cliente B não vê nada de A — nem cadastrando o MESMO repositório', async () => {
  const a = await createOwner('cliente-a', 'codex')
  const b = await createOwner('cliente-b', 'codex')
  // Dois colaboradores do MESMO repo de um terceiro — caso real e legítimo. Era
  // exatamente aqui que o vazamento acontecia.
  const repo = 'gitorch-e2e-fluxo-org/api-compartilhada'

  const projA = firstProject(await submitWizard(a, repo))
  const projB = firstProject(await submitWizard(b, repo))

  // No código antigo o wizard procurava o projeto só por `wingId`: B ACHAVA o
  // Project de A e recebia uma ApiKey válida sobre o projeto alheio.
  expect(projB.id, 'B herdou o Project de A — vazamento entre clientes').not.toBe(projA.id)
  expect(projB.wingId).toBe(repo)
  expect(projA.wingId).toBe(repo)

  // A conclui o provisionamento; B continua pendente.
  await prisma.mission.updateMany({
    where: { projectId: projA.id, type: SETUP_MISSION },
    data: { status: 'completed', completedAt: new Date() },
  })
  const missionA = await prisma.mission.findFirstOrThrow({
    where: { projectId: projA.id, type: SETUP_MISSION },
  })

  const painelB = await api<MissionsResponse>(b, 'GET', '/api/missions')
  expect(painelB.status).toBe(200)
  expect(
    painelB.body.missions.map((m) => m.id),
    'a missão de A apareceu no painel de B'
  ).not.toContain(missionA.id)
  expect(painelB.body.stats.completed, 'B está contando a missão CONCLUÍDA de A').toBe(0)

  const statusB = await api<SetupStatusResponse>(b, 'GET', '/api/v1/setup/status')
  expect(statusB.status).toBe(200)
  expect(
    statusB.body.missions.map((m) => m.projectId),
    'o status de provisionamento de B enxerga o projeto de A'
  ).toEqual([projB.id])
  expect(statusB.body.status, 'o ✓ verde de A vazou para o wizard de B').not.toBe('completed')

  // E, do outro lado, A continua vendo o que é DELE (o isolamento não pode ter
  // virado um filtro que esconde tudo de todo mundo).
  const painelA = await api<MissionsResponse>(a, 'GET', '/api/missions')
  expect(painelA.body.missions.map((m) => m.id)).toContain(missionA.id)
  expect(painelA.body.stats.completed).toBe(1)
})

test('o submit exige motor de IA conectado DE VERDADE (gate anti-fachada)', async () => {
  const cliente = await createOwner('sem-motor')
  const repo = `${cliente.githubLogin}/sem-motor`

  // 1) Sem motor nenhum: o cadastro NÃO conclui.
  const recusa = await api<SubmitResponse>(cliente, 'POST', '/api/v1/setup/submit', {
    repos: [repo],
    engines: ['codex'],
    plan: 'free',
  })
  expect(recusa.status, `esperado 400: ${JSON.stringify(recusa.body)}`).toBe(400)
  expect(recusa.body.error ?? '').toMatch(/motor/i)
  expect(
    await prisma.project.count({ where: { userId: cliente.id } }),
    'projeto criado mesmo sem motor conectado'
  ).toBe(0)

  // 2) Só com `github` conectado: a linha `github` nasce conectada no OAuth e
  // era ELA que fazia o passo 11 pintar ✓ (a tautologia). Ela NÃO é um motor de
  // IA e não pode abrir o portão.
  //
  // `upsert` porque o cliente deste cenário já entra com o GitHub conectado
  // (a prova de posse do repositório exige credencial), e a linha `github` é
  // única por cliente. O que importa aqui não é criá-la, é que ela ESTEJA
  // conectada e ainda assim não abra o portão.
  await prisma.engineConnection.upsert({
    where: { userId_runtime: { userId: cliente.id, runtime: 'github' } },
    update: { status: 'connected' },
    create: { userId: cliente.id, runtime: 'github', status: 'connected' },
  })
  const comGithub = await api<SubmitResponse>(cliente, 'POST', '/api/v1/setup/submit', {
    repos: [repo],
    engines: ['codex'],
    plan: 'free',
  })
  expect(
    comGithub.status,
    `"github" passou por motor de IA: ${JSON.stringify(comGithub.body)}`
  ).toBe(400)
  expect(await prisma.project.count({ where: { userId: cliente.id } })).toBe(0)

  // 3) Com um motor REAL conectado o portão ABRE — senão o gate seria só um 400
  // cego que reprova todo mundo.
  await prisma.engineConnection.create({
    data: {
      userId: cliente.id,
      runtime: 'codex',
      status: 'connected',
      lastValidatedAt: new Date(),
    },
  })
  const project = firstProject(
    await api<SubmitResponse>(cliente, 'POST', '/api/v1/setup/submit', {
      repos: [repo],
      engines: ['codex'],
      plan: 'free',
    })
  )
  expect(project.wingId).toBe(repo)
  await prisma.mission.findFirstOrThrow({
    where: { projectId: project.id, type: SETUP_MISSION, status: { in: ['pending', 'running'] } },
  })
})
