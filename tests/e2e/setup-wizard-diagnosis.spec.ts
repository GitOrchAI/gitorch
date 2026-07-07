import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { EngineConnectionService } from '../../apps/control-plane/dist/services/engine-connection.js'

/**
 * E2E real da F1 (diagnóstico grátis do setup wizard): navegador de verdade,
 * clone real do repo de fixture dedicado (GitOrchIA/gitorch-e2e-fixture,
 * shape fixo — ver README daquele repo), veredito/achados renderizados com
 * dados reais. Roda contra um control-plane isolado subido pelo próprio
 * workflow (banco/redis efêmeros do CI), a partir do DIST COMPILADO — o
 * processo filho do CGC (diagnose-child.js) só existe no build, não em
 * tsx/dev live (mesma exigência de codegraph-child.js).
 *
 * Precisa de E2E_GITHUB_TEST_TOKEN (conta de teste dedicada, nunca a conta
 * real) — sem ele, pula (não quebra CI de quem não tiver o secret, ex. forks).
 */

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4010'
const FIXTURE_REPO = 'GitOrchIA/gitorch-e2e-fixture'

test('diagnóstico grátis: clona a fixture real, mostra veredito + achado determinístico', async ({
  page,
  context,
}) => {
  const githubToken = process.env['E2E_GITHUB_TEST_TOKEN']
  test.skip(!githubToken, 'E2E_GITHUB_TEST_TOKEN ausente — pulando (ex.: fork sem o secret)')

  const jwtSecret = process.env['JWT_SECRET']
  if (!jwtSecret) throw new Error('JWT_SECRET ausente no ambiente do E2E')

  const prisma = new PrismaClient()
  try {
    const user = await prisma.user.upsert({
      where: { email: 'e2e-wizard@gitorch.local' },
      update: {},
      create: { email: 'e2e-wizard@gitorch.local', githubLogin: 'GitOrchIA', planId: 'free' },
    })

    const engineConnections = new EngineConnectionService(prisma as never)
    await engineConnections.connectGitHubToken(user.id, githubToken as string)

    const sessionToken = jwt.sign(
      { userId: user.id, wingId: user.githubLogin, email: user.email },
      jwtSecret,
      { expiresIn: '30m' }
    )
    const url = new URL(BASE)
    await context.addCookies([
      {
        name: 'gitorch_session',
        value: sessionToken,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
  } finally {
    await prisma.$disconnect()
  }

  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

  await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle' })

  // Sessão já autenticada pula direto pro passo 3 (Terms); só clica "Get
  // started" se o wizard não tiver pulado.
  const getStarted = page.getByRole('button', { name: /get started|começar/i })
  if (await getStarted.isVisible({ timeout: 5000 }).catch(() => false)) {
    await getStarted.click()
  }

  // Terms
  const acceptCheckbox = page.locator('input[type=checkbox]').first()
  await expect(acceptCheckbox).toBeVisible({ timeout: 15000 })
  await acceptCheckbox.check()
  await page.getByRole('button', { name: /accept|aceitar/i }).click()

  // Repos: busca pela fixture especificamente (nunca confia em "o primeiro
  // da lista" — a conta de teste pode ganhar outros repos no futuro).
  const search = page.getByPlaceholder(/search repository|buscar reposit/i)
  await expect(search).toBeVisible({ timeout: 15000 })
  await search.fill('gitorch-e2e-fixture')
  const repoButton = page.locator(`button:has-text("${FIXTURE_REPO}")`)
  await expect(repoButton).toBeVisible({ timeout: 10000 })
  await repoButton.click()
  await page.getByRole('button', { name: /continue|próximo/i }).click()

  // Diagnóstico: espera o polling terminar (clone real + CGC real, até 90s).
  await expect(page.getByText(/reading your repository|lendo o seu reposit/i)).toBeVisible()
  const scoreBadge = page.locator('.wz-diag-score')
  await expect(scoreBadge).toBeVisible({ timeout: 90_000 })

  // Achado determinístico da fixture: 3 de 5 arquivos sem teste = 60%.
  await expect(page.getByText(/60%/)).toBeVisible()
  await expect(
    page.getByText(/no matching tests|sem teste correspondente|sin test correspondiente/i)
  ).toBeVisible()

  expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([])
})
