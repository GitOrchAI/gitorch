import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import * as fs from 'node:fs'

/**
 * E2E do FECHAMENTO robusto do setup wizard (branch
 * feat/setup-wizard-fechamento-robusto) — status honesto, paste manual (D1) e
 * models/quota ao vivo (B3/F2). Usa um control-plane real (HTTP de verdade,
 * banco/Prisma de verdade) mas um MOTOR FAKE — sem OAuth real e sem
 * podman/imagem de agente real:
 *
 *   GITORCH_CODEX_BIN aponta pra fake-codex.mjs (script fake que serve tanto
 *   `codex login status` — a liveness que checkLiveness roda DIRETO no host,
 *   engine-liveness.ts:69-82 — quanto, via um shim de `podman` na frente do
 *   PATH deste processo, `codex login --device-auth` dentro do "container"
 *   do login assistido, device-login-runner.ts). O MODO (liveness viva ou
 *   morta) mora num arquivo de controle mutável
 *   (E2E_FAKE_CODEX_MODE_FILE) que cada teste reescreve — por isso a suíte
 *   inteira roda serial (test.describe.serial): dois testes mexendo no MESMO
 *   arquivo em paralelo se pisariam.
 *
 * Por que só `codex` (nunca claude/antigravity) nestes specs: claude e
 * antigravity precisam de PTY real (NEEDS_PTY em assisted-login.ts) — o
 * `node-pty-prebuilt-multiarch` é módulo nativo, frágil nesta VM arm64 (ver
 * memória `infra-native-modules-arm64-node-gyp`). `codex` usa pipes simples
 * (usePty:false), então o fake aqui nunca precisa de PTY nem de container de
 * verdade — só de um binário no PATH.
 *
 * Por que API-level (context.request/fetch), não StepConnectEngine/StepReady
 * clicados no navegador: as duas telas só são alcançáveis navegando o wizard
 * inteiro a partir do passo 4 (StepSelectRepos, lista real via GitHub API) e
 * 5 (StepDiagnosis, clone real) — infra que precisa de E2E_GITHUB_TEST_TOKEN
 * (mesmo gate de tests/e2e/setup-wizard-diagnosis.spec.ts), ausente neste
 * ambiente. O mesmo padrão de setup-wizard-assisted-login-codex.spec.ts (JWT +
 * cookie de sessão + chamadas HTTP diretas) já exercita o contrato REAL do
 * backend (status honesto, SSE) sem depender do navegador — a normalização
 * desse payload pro card (`normalizeLoginState`/`parseTokenResponse`) já tem
 * cobertura própria em apps/web/src/components/setup/engine-status.test.ts.
 *
 * Requer a infra isolada deste E2E (control-plane próprio, banco próprio,
 * fake-cli no PATH) — ausente em zero-tolerance e no e2e-wizard.yml de CI
 * (que só sobe control-plane real + podman real). Pula honestamente se
 * E2E_FAKE_CODEX_MODE_FILE não estiver setado, em vez de quebrar CI alheio.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4010'
const JWT_SECRET = process.env['JWT_SECRET']
const MODE_FILE = process.env['E2E_FAKE_CODEX_MODE_FILE']

test.describe.serial('fechamento do wizard: status honesto, paste manual, SSE ao vivo', () => {
  test.skip(
    !JWT_SECRET || !MODE_FILE,
    'JWT_SECRET/E2E_FAKE_CODEX_MODE_FILE ausentes — pulando (precisa da infra isolada deste E2E: control-plane + fake-cli próprios, não disponível em zero-tolerance/e2e-wizard.yml)'
  )

  function setLivenessMode(mode: 'ok' | 'fail') {
    fs.writeFileSync(MODE_FILE as string, mode)
  }

  /** Usuário dedicado por teste (evita um teste pisar no estado do outro). */
  async function authFor(email: string, wingId: string): Promise<string> {
    const prisma = new PrismaClient()
    let userId: string
    try {
      const user = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, githubLogin: wingId, planId: 'free' },
      })
      userId = user.id
    } finally {
      await prisma.$disconnect()
    }
    return jwt.sign({ userId, wingId, email }, JWT_SECRET as string, { expiresIn: '30m' })
  }

  function apiFor(sessionToken: string) {
    const cookie = `gitorch_session=${sessionToken}`
    return async (
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; json: unknown }> => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json', Cookie: cookie } : { Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      try {
        return { status: res.status, json: JSON.parse(text) }
      } catch {
        return { status: res.status, json: text }
      }
    }
  }

  type LoginStateShape = {
    phase: string
    message?: string
    models?: unknown
    quota?: number
  }

  /**
   * Consome o stream SSE (/login/:id/stream) até a fase terminal
   * (connected/error). ESCOLHA DELIBERADA sobre fazer polling de snapshots
   * separados (GET /login/:id sem /stream): o fake resolve tão rápido
   * (spawn+exit síncrono, sem esperar aprovação humana nenhuma — SEM OAuth
   * real) que um poll com qualquer intervalo > 0 corre risco real de
   * atravessar a fase terminal inteira entre duas tentativas — setState()
   * roda cleanup() (assisted-login.ts) LOGO após notificar a fase terminal,
   * e cleanup() apaga a sessão do Map; um GET de snapshot que chega DEPOIS
   * disso recebe 404 ("sessão não encontrada"), não a fase terminal (bug
   * real observado escrevendo este spec: a 1ª tentativa pegou 'starting', a
   * 2ª — 300ms depois — já era 404, a transição inteira coube no meio). O
   * stream não tem essa corrida: subscribe() entrega o estado atual
   * IMEDIATAMENTE e SÍNCRONO ao conectar (contrato testado em
   * assisted-login.test.ts) e continua entregando no MESMO socket já aberto
   * enquanto a sessão muda — nunca precisa de uma segunda chamada que possa
   * chegar tarde demais.
   */
  async function consumeLoginStream(
    sessionToken: string,
    loginId: string
  ): Promise<LoginStateShape> {
    const res = await fetch(`${BASE}/api/v1/engines/login/${loginId}/stream`, {
      headers: { Cookie: `gitorch_session=${sessionToken}` },
    })
    expect(res.status, `stream não abriu: ${res.status}`).toBe(200)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('resposta do stream sem corpo legível')

    const decoder = new TextDecoder()
    let buffer = ''
    let finalState: LoginStateShape | null = null
    const deadline = Date.now() + 8000
    try {
      while (!finalState && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          const state = JSON.parse(dataLine.slice('data: '.length)) as LoginStateShape
          if (state.phase === 'connected' || state.phase === 'error') {
            finalState = state
            break
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    if (!finalState) throw new Error('stream SSE nunca emitiu um estado terminal dentro do timeout')
    return finalState
  }

  test('status honesto: liveness fake que FALHA nunca vira "conectado", nem após reconsultar', async () => {
    const sessionToken = await authFor(
      'e2e-fechamento-status-honesto@gitorch.local',
      'E2EStatusHonesto'
    )
    const api = apiFor(sessionToken)

    setLivenessMode('fail')
    const start = await api('POST', '/api/v1/engines/codex/login/start')
    expect(start.status, JSON.stringify(start)).toBe(202)
    const { loginId } = start.json as { loginId: string }
    expect(loginId).toBeTruthy()

    const state = await consumeLoginStream(sessionToken, loginId)
    // Anti-fachada (assisted-login.ts onExit/captureClaudeToken): o CLI fake
    // "termina" o login (exit 0, credencial gravada), mas a liveness FAKE
    // falha (codex-mode.txt = 'fail') — o wizard tem que reportar ERRO, nunca
    // fingir 'connected'.
    expect(state.phase, `estado final: ${JSON.stringify(state)}`).toBe('error')
    expect(typeof state.message).toBe('string')
    expect((state.message ?? '').length).toBeGreaterThan(0)

    // "Recarregar": um GET fresco em /api/v1/engines (o mesmo que
    // StepConnectEngine.tsx consulta ao montar) tem que continuar honesto —
    // o motor não pode aparecer como 'connected' só porque o login "terminou".
    const reload = await api('GET', '/api/v1/engines')
    expect(reload.status).toBe(200)
    const { engines } = reload.json as { engines: Array<{ runtime: string; status: string }> }
    const codex = engines.find((e) => e.runtime === 'codex')
    expect(codex?.status, `engines após reload: ${JSON.stringify(engines)}`).not.toBe('connected')
  })

  test('paste manual (D1): credencial colada com liveness fake OK conecta de verdade', async () => {
    const sessionToken = await authFor('e2e-fechamento-paste-ok@gitorch.local', 'E2EPasteOk')
    const api = apiFor(sessionToken)

    setLivenessMode('ok')
    // .codex/auth.json é o caminho primário de ENGINE_CREDENTIAL_PATHS['codex']
    // (engine-connection.ts) e termina em .json — connectFileCredential exige
    // JSON válido antes de sequer tentar a liveness.
    const res = await api('POST', '/api/v1/engines/codex/token', {
      token: JSON.stringify({ fake: 'pasted-credential-ok' }),
    })
    expect(res.status, JSON.stringify(res)).toBe(200)
    const body = res.json as { connected: boolean; status: { status: string } }
    expect(body.connected).toBe(true)
    expect(body.status.status).toBe('connected')
  })

  test('paste manual (D1): credencial colada com liveness fake FALHA não conecta (erro honesto)', async () => {
    const sessionToken = await authFor('e2e-fechamento-paste-fail@gitorch.local', 'E2EPasteFail')
    const api = apiFor(sessionToken)

    setLivenessMode('fail')
    const res = await api('POST', '/api/v1/engines/codex/token', {
      token: JSON.stringify({ fake: 'pasted-credential-fail' }),
    })
    // A ROTA responde 200 (a chamada em si foi bem-sucedida) — é o CAMPO
    // `connected` que carrega o veredito honesto (engines.ts: "connected:
    // status.status==='connected'"), nunca um 4xx genérico.
    expect(res.status, JSON.stringify(res)).toBe(200)
    const body = res.json as {
      connected: boolean
      status: { status: string; lastError: string | null }
    }
    expect(body.connected).toBe(false)
    expect(body.status.status).toBe('error')
    expect(body.status.lastError).toBeTruthy()
  })

  test('models/quota ao vivo (B3/F2): evento SSE "connected" carrega models+quota sem precisar recarregar', async () => {
    const sessionToken = await authFor('e2e-fechamento-sse-models@gitorch.local', 'E2ESseModels')
    const api = apiFor(sessionToken)

    setLivenessMode('ok')
    const start = await api('POST', '/api/v1/engines/codex/login/start')
    expect(start.status, JSON.stringify(start)).toBe(202)
    const { loginId } = start.json as { loginId: string }

    // Mesmo helper de stream do teste "status honesto" (ver comentário lá
    // sobre por que /stream, nunca polling de snapshot). Isto testa o
    // CONTRATO cru que o card depende (LoginState com phase:'connected',
    // models, quota — assisted-login.ts onExit/captureClaudeToken); a
    // normalização desse payload em "N modelos" já é coberta por
    // normalizeLoginState em engine-status.test.ts.
    const finalState = await consumeLoginStream(sessionToken, loginId)

    expect(finalState.phase, `estado final: ${JSON.stringify(finalState)}`).toBe('connected')
    // Fiel ao fake-codex.mjs: 2 modelos, quota restante 42 (usage.json).
    expect(Array.isArray(finalState.models)).toBe(true)
    expect((finalState.models as unknown[]).length).toBe(2)
    expect(finalState.quota).toBe(42)
  })

  // StepReady (F1, "ativando" -> concluído sem spinner eterno): a tela só é
  // alcançável navegando o wizard inteiro (passo 11), que passa por
  // StepSelectRepos (lista real via GitHub API) e StepDiagnosis (clone real)
  // — a MESMA infra de GitHub que setup-wizard-diagnosis.spec.ts exige via
  // E2E_GITHUB_TEST_TOKEN, ausente neste ambiente. Fabricar essa navegação
  // via page.route() (mockando /api/v1/github/repos, /setup/clone, /diagnose e
  // /setup/submit) testaria a UI contra dados inventados por este teste, não
  // contra o contrato real do backend — o oposto do que os comentários
  // anti-fachada deste código pedem. A lógica PURA que StepReady usa
  // (deriveProvisionStatus: >=1 conectado -> 'ready') já tem teste unitário em
  // engine-status.test.ts. Fica pulado aqui, honestamente, até existir um
  // E2E_GITHUB_TEST_TOKEN neste ambiente (ou um fixture de repo dedicado, como
  // GitOrchIA/gitorch-e2e-fixture) para navegar o wizard de ponta a ponta.
  test.skip('StepReady (F1): motor conectado faz o item "ativando" virar concluído — PULADO, ver comentário', () => {})
})
