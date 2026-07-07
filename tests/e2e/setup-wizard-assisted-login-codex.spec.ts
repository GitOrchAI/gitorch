import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

/**
 * Verifica o CONTRATO do login assistido do Codex até o ponto que dá pra
 * automatizar sem humano: o backend sobe o container de verdade, o CLI real
 * emite a URL+código de device-auth, e isso fica disponível pra quem consulta
 * o estado da sessão. NÃO aprova o login (isso exigiria uma conta OpenAI real
 * clicando "Allow" em auth.openai.com — fora do alcance de CI). Claude e
 * Antigravity não têm equivalente automatizável (dependem de aprovação humana
 * numa página OAuth de verdade) — ver o checklist de QA manual em
 * tests/e2e/ASSISTED-LOGIN-MANUAL-QA.md (Task 5 do plano de login assistido).
 *
 * Sobre o polling: `page.request.get` (cliente HTTP simples do Playwright) não
 * consome Server-Sent Events como stream — apontar isto pra rota
 * `/api/v1/engines/login/:loginId/stream` não validaria nada de verdade. Por
 * isso o teste faz polling em `GET /api/v1/engines/login/:loginId` (sem
 * `/stream`), um snapshot JSON puro do estado adicionado justamente para este
 * caso (e como fallback de polling do frontend se o `EventSource` falhar).
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4010'

test('login assistido do Codex: sobe container real, CLI real emite link+código reais de device-auth', async ({
  context,
}) => {
  // Este spec precisa de um control-plane real de pé + podman real com a
  // imagem do agente já construída — infra que só o job `e2e-wizard.yml`
  // provisiona (JWT_SECRET efêmero, banco/redis próprios). O `zero-tolerance`
  // (roda em todo PR, sem essa infra) não tem JWT_SECRET — pula aqui em vez
  // de derrubar o gate genérico, mesmo padrão já usado em
  // setup-wizard-diagnosis.spec.ts para E2E_GITHUB_TEST_TOKEN.
  const jwtSecret = process.env['JWT_SECRET']
  test.skip(
    !jwtSecret,
    'JWT_SECRET ausente — pulando (ambiente sem infra de E2E, ex.: zero-tolerance)'
  )
  if (!jwtSecret) return // inalcançável em runtime (test.skip já parou); só para o typecheck estreitar o tipo

  const prisma = new PrismaClient()
  let userId: string
  try {
    const user = await prisma.user.upsert({
      where: { email: 'e2e-assisted-login@gitorch.local' },
      update: {},
      create: {
        email: 'e2e-assisted-login@gitorch.local',
        githubLogin: 'GitOrchIA',
        planId: 'free',
      },
    })
    userId = user.id
  } finally {
    await prisma.$disconnect()
  }

  const sessionToken = jwt.sign(
    { userId, wingId: 'GitOrchIA', email: 'e2e-assisted-login@gitorch.local' },
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

  const startRes = await context.request.post(`${BASE}/api/v1/engines/codex/login/start`)
  expect(startRes.status()).toBe(202)
  const { loginId } = (await startRes.json()) as { loginId: string }
  expect(loginId).toBeTruthy()

  // Polling do snapshot JSON puro (não SSE) até a fase virar 'url_ready' — o
  // container real leva alguns segundos pra subir e o `codex` real leva mais
  // um instante pra imprimir o prompt de device-auth.
  let state: { phase: string; url?: string; code?: string; message?: string } | null = null
  for (let i = 0; i < 30; i++) {
    const res = await context.request.get(`${BASE}/api/v1/engines/login/${loginId}`)
    expect(res.status()).toBe(200)
    state = (await res.json()) as typeof state
    if (state?.phase === 'url_ready' || state?.phase === 'error') break
    await new Promise((r) => setTimeout(r, 1000))
  }

  expect(
    state,
    'estado do login nunca chegou a url_ready/error dentro do timeout de polling'
  ).not.toBeNull()
  expect(state?.phase, `estado final: ${JSON.stringify(state)}`).toBe('url_ready')
  expect(state?.url).toMatch(/^https:\/\/auth\.openai\.com\/codex\/device/)
  // Código de uso único no formato XXXX-XXXXX do device-auth do Codex.
  expect(state?.code).toMatch(/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/)
})
