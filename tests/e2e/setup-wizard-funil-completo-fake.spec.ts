import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { EngineConnectionService } from '../../apps/control-plane/dist/services/engine-connection.js'

/**
 * E2E do FUNIL INTEIRO do setup wizard (Onda 4 — "Prova"): passos 1 a 11,
 * navegados de VERDADE no navegador (não API-level), com
 * GITORCH_FAKE_ENGINES=1 (services/fake-engines.ts) — login assistido e
 * liveness dos 3 motores são fakes determinísticos, sem podman/CLI real. O
 * único ponto real que sobrevive é o clone + diagnóstico + provisionamento
 * contra a fixture pública dedicada (GitOrchIA/gitorch-e2e-fixture,
 * pequena e controlada — não precisa de token real: repos GitHub públicos
 * clonam anônimos, e a listagem de repositórios é interceptada no navegador
 * via page.route, então nunca bate na API real do GitHub).
 *
 * Existe para matar "disseram pronto sem prova": este é o spec que roda em
 * TODO PR (ver .github/workflows/ci.yml, job e2e-funil-fake) e prova que o
 * funil INTEIRO — login, termos, seleção de repo, clone, diagnóstico com
 * grafo 3D, conexão dos 3 motores, telegram, plano, submit e status final —
 * ainda fecha de ponta a ponta a cada mudança, não só os pedaços isolados
 * que os outros specs cobrem.
 *
 * NÃO se auto-pula: GITORCH_FAKE_ENGINES=1/JWT_SECRET/DATABASE_URL ausentes
 * fazem o teste LANÇAR no beforeAll (não test.skip) — um guarda que se pula
 * sozinho não guarda nada (mesmo raciocínio de
 * setup-wizard-fluxo-completo.spec.ts). Precisa da infra própria deste E2E
 * (control-plane + Postgres reais, controlados pelo workflow) — ausente em
 * zero-tolerance (ver playwright.config.ts: só coletado quando há
 * DATABASE_URL).
 */

const BASE = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:4010'
const JWT_SECRET = process.env['JWT_SECRET'] ?? ''
const FIXTURE_REPO = 'GitOrchIA/gitorch-e2e-fixture'
const NS = 'e2e-funil-fake'

const prisma = new PrismaClient()

interface Owner {
  id: string
  email: string
  githubLogin: string
  session: string
}

async function createOwner(): Promise<Owner> {
  const suffix = Math.random().toString(36).slice(2, 10)
  const email = `${NS}-${suffix}@gitorch.local`
  const githubLogin = `${NS}-${suffix}`
  const user = await prisma.user.create({ data: { email, githubLogin, planId: 'free' } })

  // GitHub "conectado" com um token FAKE — nunca falado com o GitHub aqui
  // (connectGitHubToken só escreve um arquivo local e cifra; zero rede). É
  // necessário porque POST /api/v1/diagnose exige `getRawGithubToken` !=
  // null (routes/diagnose.ts) — mas o valor em si nunca importa: o repo é
  // PÚBLICO (git clone anônimo funciona), a listagem é interceptada no
  // navegador (nunca chega nesta rota), e fetchGithubSignals degrada
  // sozinho para valores neutros em qualquer 401 (github-signals.ts
  // safeJson) — nunca derruba o diagnóstico.
  const engineConnections = new EngineConnectionService(prisma as never)
  await engineConnections.connectGitHubToken(user.id, `fake-github-token-${suffix}`)

  const session = jwt.sign({ userId: user.id, wingId: githubLogin, email }, JWT_SECRET, {
    expiresIn: '30m',
  })
  return { id: user.id, email, githubLogin, session }
}

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

/** Intercepta a listagem de repos do GitHub — nunca bate na API real (sem
 *  rate-limit, sem depender de credencial real). O clone/diagnóstico
 *  seguintes SÃO reais, contra a fixture pública. */
async function interceptGithubRepoListing(page: Page): Promise<void> {
  await page.route('**/api/v1/github/repos', async (route) => {
    await route.fulfill({
      json: [
        {
          id: 1,
          name: 'gitorch-e2e-fixture',
          fullName: FIXTURE_REPO,
          description: 'Fixture pública e controlada do E2E do GitOrch',
          private: false,
          url: `https://github.com/${FIXTURE_REPO}`,
        },
      ],
    })
  })
}

const primaryButton = (page: Page) => page.locator('.wz-actions .wz-btn-primary')

test.beforeAll(async () => {
  if (process.env['GITORCH_FAKE_ENGINES'] !== '1') {
    throw new Error(
      'GITORCH_FAKE_ENGINES=1 ausente — este E2E exige os motores fake (sem isso, o passo 7 tentaria abrir um container podman de verdade)'
    )
  }
  if (!JWT_SECRET) throw new Error('JWT_SECRET ausente — este E2E exige o control-plane real')
  if (!process.env['DATABASE_URL'])
    throw new Error('DATABASE_URL ausente — este E2E exige o Postgres real')
  await cleanup()
})

test.afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

test('funil completo do setup wizard: login → termos → repo → diagnóstico+grafo → 3 motores fake → telegram → plano → submit → pronto', async ({
  page,
}) => {
  test.setTimeout(180_000)

  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

  const owner = await createOwner()
  await page.context().addCookies([
    {
      name: 'gitorch_session',
      value: owner.session,
      domain: new URL(BASE).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  await interceptGithubRepoListing(page)

  await test.step('passo 1-2: chegada + sessão já autenticada pula pro passo 3', async () => {
    await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle' })
    const getStarted = page.getByRole('button', { name: /get started|começar/i })
    if (await getStarted.isVisible({ timeout: 5000 }).catch(() => false)) {
      await getStarted.click()
    }
  })

  await test.step('passo 3: termos', async () => {
    const acceptCheckbox = page.locator('input[type=checkbox]').first()
    await expect(acceptCheckbox).toBeVisible({ timeout: 15000 })
    await acceptCheckbox.check()
    await page.getByRole('button', { name: /accept|aceitar/i }).click()
  })

  await test.step('passo 4: seleção de repo (listagem interceptada) + clone real (fixture pública)', async () => {
    const search = page.getByPlaceholder(/search repository|buscar reposit/i)
    await expect(search).toBeVisible({ timeout: 15000 })
    await search.fill('gitorch-e2e-fixture')
    const repoButton = page.locator(`button:has-text("${FIXTURE_REPO}")`)
    await expect(repoButton).toBeVisible({ timeout: 10000 })
    await repoButton.click()
    await primaryButton(page).click() // dispara POST /setup/clone (real, repo público)
  })

  await test.step('passo 5: diagnóstico real (clone reaproveitado) + grafo 3D (rota 200 + canvas monta)', async () => {
    await expect(page.getByText(/reading your repository|lendo o seu reposit/i)).toBeVisible()

    const graphResponsePromise = page.waitForResponse(
      (resp) => /\/api\/v1\/diagnose\/[^/]+\/graph$/.test(new URL(resp.url()).pathname),
      { timeout: 90_000 }
    )

    const scoreBadge = page.locator('.wz-diag-score')
    await expect(scoreBadge).toBeVisible({ timeout: 90_000 })
    // Achado determinístico da fixture (mesmo repo de
    // setup-wizard-diagnosis.spec.ts): 3 de 5 arquivos sem teste = 60%.
    await expect(page.getByText(/60%/)).toBeVisible()

    const graphResponse = await graphResponsePromise
    expect(graphResponse.status(), 'GET /diagnose/:id/graph não respondeu 200').toBe(200)

    // O canvas do grafo 3D (react-three-fiber) — melhor esforço honesto: só
    // afirma "montou" se webgl2/webgl estiver disponível no navegador (a
    // MESMA guarda que StepDiagnosis usa, graph3d-layout.ts
    // isWebglAvailable); sem WebGL o componente nem tenta montar o Canvas
    // (cai no fallback em tabela) — comportamento correto, não uma falha
    // deste teste.
    const webglAvailable = await page.evaluate(() => {
      const c = document.createElement('canvas')
      return !!(c.getContext('webgl2') ?? c.getContext('webgl'))
    })
    if (webglAvailable) {
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    }

    await primaryButton(page).click()
  })

  await test.step('passo 6: seleciona os 3 motores (claude-code já vem por padrão)', async () => {
    await expect(page.locator('.wz-opt', { hasText: 'Codex' })).toBeVisible({ timeout: 10000 })
    await page.locator('.wz-opt', { hasText: 'Codex' }).click()
    await page.locator('.wz-opt', { hasText: 'Antigravity' }).click()
    await primaryButton(page).click()
  })

  await test.step('passo 7: conecta os 3 motores fake — cada um mostra os NOMES dos modelos + quota', async () => {
    for (const name of ['Claude Code', 'Codex', 'Antigravity']) {
      const card = page.locator('div.rounded-2xl.p-5', { hasText: name })
      await expect(card, `card de ${name} não apareceu`).toBeVisible({ timeout: 10000 })
      await card.getByRole('button', { name: /connect|conectar|conecta/i }).click()
      // Fake: instantâneo (sem container/CLI real) — SSE entrega
      // starting -> connected em milissegundos. fake-model-a/fake-model-b e
      // quota 900 são FAKE_MODELS/FAKE_QUOTA (services/fake-engines.ts). 20/07
      // (fix/w2-model-names-quota): a tela passou a mostrar os NOMES dos
      // modelos, não mais uma contagem — o teste trava o texto real.
      await expect(
        card.getByText(/fake-model-a/i),
        `${name} não mostrou os nomes dos modelos fake — liveness fake não conectou`
      ).toBeVisible({ timeout: 15000 })
      await expect(card.getByText(/fake-model-b/i)).toBeVisible()
      await expect(card.getByText(/900/)).toBeVisible()
      await expect(card.getByText(/connected|conectado/i)).toBeVisible()
    }
    await primaryButton(page).click()
  })

  await test.step('passo 8: telegram (opcional) — pula', async () => {
    await primaryButton(page).click()
  })

  await test.step('passo 9: plano (mantém Free)', async () => {
    await primaryButton(page).click()
  })

  let projectId: string | undefined
  await test.step('passo 10: confirmação + submit', async () => {
    await expect(page.getByText(FIXTURE_REPO)).toBeVisible({ timeout: 10000 })
    const submitResponsePromise = page.waitForResponse(
      (resp) => new URL(resp.url()).pathname === '/api/v1/setup/submit',
      { timeout: 30_000 }
    )
    await primaryButton(page).click()
    const submitResponse = await submitResponsePromise
    expect(submitResponse.status(), 'POST /setup/submit falhou').toBe(200)
    const body = (await submitResponse.json()) as {
      projects?: Array<{ id: string; apiKey: string }>
    }
    projectId = body.projects?.[0]?.id
    expect(projectId, 'submit não devolveu o projeto criado').toBeTruthy()
  })

  await test.step('passo 11: StepReady — chave de API + status real até terminal', async () => {
    // A chave (única exibição em texto puro) precisa aparecer — é o produto
    // real desta submissão, não decoração.
    await expect(page.locator('.select-all.truncate', { hasText: /^gitorch_/ })).toBeVisible({
      timeout: 10000,
    })

    // Status REAL do provisionamento (GET /api/v1/setup/status, missão
    // clone_and_start_engines processada pelo scheduler real —
    // GITORCH_SCHEDULER_TICK_MS acelera o tick pra este E2E não esperar
    // 60s). Falha e sucesso são o MESMO locator: se cair em "falhou", a
    // asserção seguinte mostra a causa em vez de só estourar timeout cego.
    const terminal = page
      .locator('.wz-body')
      .getByText(
        /ambiente ativo|environment is live|entorno activo|provisionamento falhou|provisioning failed|aprovisionamiento falló/i
      )
    await expect(terminal, 'provisionamento nunca chegou a um estado terminal').toBeVisible({
      timeout: 90_000,
    })
    const terminalText = await terminal.innerText()
    expect(terminalText, `StepReady terminou em FALHA, não em sucesso: "${terminalText}"`).toMatch(
      /ambiente ativo|environment is live|entorno activo/i
    )
  })

  await test.step('confirmação de fora da UI: a missão está REALMENTE completed no banco', async () => {
    expect(projectId).toBeTruthy()
    const mission = await prisma.mission.findFirstOrThrow({
      where: { projectId, type: 'clone_and_start_engines' },
    })
    expect(mission.status, `missão real: ${JSON.stringify(mission)}`).toBe('completed')
  })

  expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([])
})
