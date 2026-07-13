/* eslint-disable no-console */
/**
 * Task A2 — Captura REAL do stdout cru (bytes ANSI intactos) dos CLIs de login
 * assistido, para gerar os golden fixtures que guiam os fixes E1 (Claude) e E2
 * (Antigravity). NÃO consertar às cegas: primeiro ver o byte real.
 *
 * Usa exatamente o mesmo runner de produção (`runDeviceLogin`) e os mesmos
 * BINARY/ARGS/NEEDS_PTY de `assisted-login.ts`, para o que sai aqui ser
 * bit-a-bit o que o wizard vê. Mimetiza o wizard: para o agy, ao ver
 * `/select login method/i` envia UM `\r` (e só um), como o orquestrador hoje.
 *
 * Segredos: o buffer é REDIGIDO antes de tocar o disco (token -> REDACTED,
 * state=/code= das URLs OAuth -> REDACTED). Nunca grava token cru.
 *
 * Uso (a partir da raiz do repo):
 *   pnpm exec tsx scripts/dev/capture-cli-stdout.ts agy
 *   pnpm exec tsx scripts/dev/capture-cli-stdout.ts claude
 *   pnpm exec tsx scripts/dev/capture-cli-stdout.ts all
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { runDeviceLogin } from '../../packages/agents/src/device-login-runner'

type Runtime = 'antigravity' | 'claude' | 'codex'

// Espelho fiel de assisted-login.ts (BINARY/ARGS/NEEDS_PTY).
const BINARY: Record<Runtime, string> = { codex: 'codex', claude: 'claude', antigravity: 'agy' }
const ARGS: Record<Runtime, string[]> = {
  codex: ['login', '--device-auth'],
  claude: ['setup-token'],
  antigravity: [],
}
const NEEDS_PTY: Record<Runtime, boolean> = { codex: false, claude: true, antigravity: true }
const FIXTURE_NAME: Record<Runtime, string> = {
  antigravity: 'agy-login.stdout.txt',
  claude: 'claude-setup-token.stdout.txt',
  codex: 'codex-login.stdout.txt',
}

// Marcadores (mesmos regex do orquestrador/parser reais).
const MENU_MARKER = /select login method/i
const GOOGLE_URL = /https:\/\/accounts\.google\.com/
const CLAUDE_URL = /https:\/\/claude\.com\/cai\/oauth\/authorize/
const CODEX_URL = /https:\/\/auth\.openai\.com/
const CLAUDE_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]+/

const HARD_CAP_MS = Number(process.env['HARD_CAP_MS'] ?? 90_000)
const CLAUDE_URL_GRACE_MS = 5_000
// Probe: pular o \r do menu (ver o que o agy faz sozinho — terms? trava? sai?).
const SKIP_ENTER = process.env['SKIP_ENTER'] === '1'

/**
 * Redige o buffer preservando TODA a moldura (ANSI/box-draw/OSC-8) — só o VALOR
 * do segredo vira REDACTED. É a moldura que interessa a E1/E2; o valor não pode
 * vazar pro repo.
 */
function redact(s: string): string {
  return s
    .replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, 'sk-ant-oat01-REDACTED')
    .replace(/([?&](?:state|code|access_token|id_token|refresh_token)=)[^&\s\]"'`]+/g, '$1REDACTED')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function capture(runtime: Runtime): Promise<void> {
  const image = process.env['GITORCH_AGENT_IMAGE'] ?? 'localhost/gitorch-agent:latest'
  const fixturesDir = path.join(process.cwd(), 'apps/control-plane/src/services/__fixtures__')
  await fs.mkdir(fixturesDir, { recursive: true })

  console.error(
    `\n=== capturando ${runtime} :: ${BINARY[runtime]} ${ARGS[runtime].join(' ')} :: pty=${NEEDS_PTY[runtime]} :: image=${image} ===`
  )

  const handle = runDeviceLogin({
    image,
    binary: BINARY[runtime],
    args: ARGS[runtime],
    usePty: NEEDS_PTY[runtime],
  })

  let buffer = ''
  let sentMenuEnter = false
  let menuSeenAtMs = 0
  let urlSeenAtMs = 0
  let exited = false
  let exitCode: number | null = null
  const start = Date.now()

  handle.onStdout((chunk) => {
    buffer += chunk
    // Mimetiza o wizard: UM \r ao ver o menu do agy. Nada mais.
    if (runtime === 'antigravity' && !sentMenuEnter && MENU_MARKER.test(buffer)) {
      sentMenuEnter = true
      menuSeenAtMs = Date.now() - start
      if (SKIP_ENTER) {
        console.error(`[${runtime}] menu visto @${menuSeenAtMs}ms -> SKIP_ENTER: NÃO enviando \\r`)
      } else {
        console.error(`[${runtime}] menu "Select login method" @${menuSeenAtMs}ms -> enviando \\r`)
        handle.writeStdin('\r')
      }
    }
    if (runtime === 'claude' && urlSeenAtMs === 0 && CLAUDE_URL.test(buffer)) {
      urlSeenAtMs = Date.now() - start
      console.error(`[${runtime}] URL claude @${urlSeenAtMs}ms`)
    }
    if (runtime === 'antigravity' && urlSeenAtMs === 0 && GOOGLE_URL.test(buffer)) {
      urlSeenAtMs = Date.now() - start
      console.error(`[${runtime}] URL google @${urlSeenAtMs}ms`)
    }
  })

  void handle.exited.then(({ code }) => {
    exited = true
    exitCode = code
    console.error(`[${runtime}] processo saiu code=${code} @${Date.now() - start}ms`)
  })

  const stopReason = await new Promise<string>((resolve) => {
    const iv = setInterval(() => {
      const elapsed = Date.now() - start
      if (exited) {
        clearInterval(iv)
        resolve(`process-exited(code=${exitCode})`)
        return
      }
      if (runtime === 'antigravity' && GOOGLE_URL.test(buffer)) {
        clearInterval(iv)
        resolve('found-google-url')
        return
      }
      if (runtime === 'claude') {
        if (CLAUDE_TOKEN.test(buffer)) {
          clearInterval(iv)
          resolve('found-token')
          return
        }
        // URL apareceu: espera uma graça curta pra capturar a moldura completa
        // impressa DEPOIS da URL, então para (o CLI ficaria pendurado esperando
        // o código colado — sem sentido esperar 90s).
        if (urlSeenAtMs > 0 && elapsed - urlSeenAtMs >= CLAUDE_URL_GRACE_MS) {
          clearInterval(iv)
          resolve('found-url+grace')
          return
        }
      }
      if (runtime === 'codex' && CODEX_URL.test(buffer)) {
        clearInterval(iv)
        resolve('found-codex-url')
        return
      }
      if (elapsed >= HARD_CAP_MS) {
        clearInterval(iv)
        resolve('timeout-90s')
        return
      }
    }, 250)
  })

  handle.kill()
  await delay(1200) // deixa o SIGTERM propagar e o container --rm sumir

  const redacted = redact(buffer)
  // Probe (SKIP_ENTER) grava com sufixo pra NÃO sobrescrever o fixture bom.
  const fileName = SKIP_ENTER
    ? FIXTURE_NAME[runtime].replace('.txt', '.noenter.txt')
    : FIXTURE_NAME[runtime]
  const outPath = path.join(fixturesDir, fileName)
  await fs.writeFile(outPath, redacted, 'utf8')

  // Limpa o HOME temporário (pode conter fragmento de credencial). Só o efêmero
  // (este script nunca passa envHome, então é sempre mkdtemp).
  await fs.rm(handle.hostHome, { recursive: true, force: true }).catch(() => undefined)

  const rawHasToken = CLAUDE_TOKEN.test(buffer)
  const leak = /sk-ant-oat01-(?!REDACTED)[A-Za-z0-9_-]+/.test(redacted)
  console.error(
    `[${runtime}] STOP reason=${stopReason} elapsed=${Date.now() - start}ms rawBytes=${Buffer.byteLength(buffer)} redactedBytes=${Buffer.byteLength(redacted)}`
  )
  console.error(
    `[${runtime}] menuSeen=${sentMenuEnter}(@${menuSeenAtMs}ms) urlSeen=${urlSeenAtMs > 0}(@${urlSeenAtMs}ms) tokenSeenRaw=${rawHasToken}`
  )
  console.error(`[${runtime}] escrito -> ${outPath}`)
  if (leak) {
    console.error(
      `[${runtime}] !!! ALERTA: possível token NÃO redigido no fixture — INSPECIONAR antes de qualquer commit`
    )
  }
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? 'antigravity').toLowerCase()
  const runtimes: Runtime[] =
    arg === 'all'
      ? ['antigravity', 'claude']
      : arg === 'agy' || arg === 'antigravity'
        ? ['antigravity']
        : arg === 'claude'
          ? ['claude']
          : arg === 'codex'
            ? ['codex']
            : ['antigravity']

  for (const rt of runtimes) {
    await capture(rt)
  }
  console.error('\nDONE')
  process.exit(0)
}

void main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
