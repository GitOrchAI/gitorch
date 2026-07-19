import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { mkdtempSync } from 'node:fs'
import type { DeviceLoginHandle, DeviceLoginOptions } from '@gitorch/agents'
import { ENGINE_CREDENTIAL_PATHS } from './engine-connection.js'
import type { CheckLivenessDeps, LivenessRunner } from './engine-liveness.js'
import type { ModelDiscoverer } from './model-catalog.js'
import type { QuotaReader } from './quota-reader.js'

/**
 * Onda 4 (prova do funil): GITORCH_FAKE_ENGINES=1 troca TODO o caminho de
 * motor (login assistido, liveness, catálogo de modelos, quota) por fakes
 * determinísticos — sem container/podman, sem CLI real, sem credencial de
 * provider nenhuma. Existe SÓ para o E2E do funil completo rodar em todo PR
 * (tests/e2e/setup-wizard-funil-completo-fake.spec.ts) sem depender de
 * segredos externos nem de infra pesada (imagem de agente, binários de CLI).
 *
 * NUNCA liga sozinho: precisa do env explícito E de NODE_ENV !== 'production'
 * (defesa em profundidade — mesmo um '1' vazado por engano num .env de
 * produção não ativa os fakes). Ver .env.example para o aviso ao operador.
 */
export const FAKE_ENGINES_FLAG = 'GITORCH_FAKE_ENGINES'

export function fakeEnginesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FAKE_ENGINES_FLAG] === '1' && env['NODE_ENV'] !== 'production'
}

// Determinístico e nomeado para nunca ser confundido com um modelo real —
// qualquer teste/QA que veja "fake-model-*" na tela sabe na hora que está sob
// GITORCH_FAKE_ENGINES.
export const FAKE_MODELS: readonly string[] = ['fake-model-a', 'fake-model-b']
export const FAKE_QUOTA = { remaining: 900, total: 1000 } as const

const fakeDiscoverer: ModelDiscoverer = async () => [...FAKE_MODELS]
const fakeQuotaReader: QuotaReader = async () => ({ ...FAKE_QUOTA })

export const FAKE_MODEL_DISCOVERERS: Record<string, ModelDiscoverer> = {
  antigravity: fakeDiscoverer,
  codex: fakeDiscoverer,
  claude: fakeDiscoverer,
}

export const FAKE_QUOTA_READERS: Record<string, QuotaReader> = {
  antigravity: fakeQuotaReader,
  codex: fakeQuotaReader,
  claude: fakeQuotaReader,
}

// checkLiveness() SEMPRE chama `runner` primeiro para decidir `alive` (ver
// engine-liveness.ts) — nunca spawna nada de verdade aqui, só resolve.
const fakeLivenessRunner: LivenessRunner = async () => 'fake-engines: liveness sempre viva'

export const FAKE_LIVENESS_DEPS: CheckLivenessDeps = {
  runner: fakeLivenessRunner,
  discoverers: FAKE_MODEL_DISCOVERERS,
  quotaReaders: FAKE_QUOTA_READERS,
}

// `claude setup-token` real emite "sk-ant-oat01-<corpo>"; extractClaudeToken
// (device-prompt-parser.ts) exige corpo >= 8 chars. O fake respeita a MESMA
// forma para exercitar o parser real, não um atalho que o contorna.
const FAKE_CLAUDE_TOKEN = `sk-ant-oat01-fake-e2e-${'a'.repeat(24)}`

// Inverso de BINARY (assisted-login.ts) — não exportado de lá, pequeno o
// bastante para duplicar aqui sem acoplar os dois módulos.
const RUNTIME_BY_BINARY: Record<string, 'codex' | 'claude' | 'antigravity'> = {
  codex: 'codex',
  claude: 'claude',
  agy: 'antigravity',
}

/**
 * Escreve uma credencial FAKE no caminho PRIMÁRIO que
 * ENGINE_CREDENTIAL_PATHS espera para `runtime`, dentro de `homeDir` — é
 * exatamente o que `archivePaths` (captureFromHome) precisa achar em disco
 * para "capturar" a conexão, sem nenhum login real ter acontecido.
 */
async function writeFakeCredentialFile(runtime: string, homeDir: string): Promise<void> {
  const primary = ENGINE_CREDENTIAL_PATHS[runtime]?.[0]
  if (!primary) return
  const dest = path.join(homeDir, primary)
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
  await fs.writeFile(
    dest,
    JSON.stringify({ fake: true, runtime, issuedAt: new Date().toISOString() }),
    { mode: 0o600 }
  )
}

/**
 * Substitui `runDeviceLogin` (packages/agents/device-login-runner.ts): login
 * instantâneo, sem container/podman/CLI real. Segue o MESMO contrato que
 * AssistedLoginService espera de um login de verdade — só que em
 * milissegundos:
 *
 *   - claude: emite o token fake via stdout (extractClaudeToken casa o
 *     mesmo regex do CLI real) — dispara captureClaudeToken(), que grava o
 *     token em .gitorch/env/CLAUDE_CODE_OAUTH_TOKEN e chama captureFromHome.
 *   - codex/antigravity: escreve a credencial fake no caminho que
 *     ENGINE_CREDENTIAL_PATHS espera e "sai" com código 0 — dispara onExit(),
 *     que chama captureFromHome com o MESMO hostHome.
 *
 * Em ambos os casos a liveness que roda em seguida (dentro de
 * captureFromHome) também precisa estar fakeada (FAKE_LIVENESS_DEPS) — senão
 * captureFromHome chamaria o comando real (`codex login status` etc.) e a
 * conexão morreria com "binário não encontrado".
 */
export function fakeRunDeviceLogin(options: DeviceLoginOptions): DeviceLoginHandle {
  const hostHome = options.makeHomeImpl
    ? options.makeHomeImpl()
    : mkdtempSync(path.join(os.tmpdir(), 'gitorch-fake-login-'))
  const runtime = RUNTIME_BY_BINARY[options.binary] ?? 'codex'

  const stdoutCbs: Array<(chunk: string) => void> = []
  let resolveExited: (result: { code: number | null }) => void = () => undefined
  const exited = new Promise<{ code: number | null }>((resolve) => {
    resolveExited = resolve
  })

  // setImmediate (não síncrono): garante que AssistedLoginService.start() já
  // assinou onStdout/exited.then ANTES do fake "acontecer" — a mesma ordem
  // que um processo real teria (spawn nunca resolve antes do handle voltar
  // para quem chamou).
  setImmediate(() => {
    void (async () => {
      try {
        if (runtime === 'claude') {
          for (const cb of stdoutCbs) cb(FAKE_CLAUDE_TOKEN)
        } else {
          await writeFakeCredentialFile(runtime, hostHome)
        }
      } finally {
        resolveExited({ code: 0 })
      }
    })()
  })

  return {
    hostHome,
    onStdout: (cb) => stdoutCbs.push(cb),
    writeStdin: () => undefined,
    exited,
    kill: () => undefined,
  }
}
