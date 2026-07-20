import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Aquecimento do Codex: prompt mínimo e diretivo (sem tools), sandbox
// read-only, timeout curto — nunca segura o connect se o provider estiver
// lento/fora do ar. Reproduzido de verdade nesta VM (2026-07-20) contra o
// codex-cli 0.142.5: ~19s e ~2.4k tokens; a margem cobre reasoning mais lento
// sem deixar o usuário esperando minutos.
const CODEX_WARMUP_TIMEOUT_MS = 30_000

// Catálogo DINÂMICO de modelos por provider: novos modelos aparecem sozinhos
// como opção para o cliente. Cada motor descobre de um jeito próprio; a lista
// vem sempre da fonte do provider, nunca hardcode que envelhece.

export type ModelDiscoverer = (homeDir: string) => Promise<string[]>

/** Antigravity: `agy models` imprime um modelo por linha. */
export function makeAntigravityDiscoverer(
  agyBin = process.env['GITORCH_AGY_BIN'] ?? 'agy',
  runner: (bin: string, args: string[], home: string) => Promise<string> = defaultRunner
): ModelDiscoverer {
  return async (homeDir: string) => {
    const out = await runner(agyBin, ['models'], homeDir)
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }
}

/**
 * Codex: lê ~/.codex/models_cache.json (models[].display_name || slug). O
 * cache só nasce depois de uma sessão REAL do CLI (`codex exec`) — nem
 * `codex login` nem `codex login status` o geram (reproduzido 2026-07-20: um
 * HOME só com auth.json + `codex login status` não cria o arquivo; um
 * `codex exec` no MESMO HOME cria). É por isso que o dono via "conectou" mas
 * 0 modelos: a liveness (`codex login status`) passava, mas o catálogo nunca
 * tinha sido buscado. Se o cache ainda não existe, dispara UM aquecimento
 * barato e real (ver `defaultCodexWarmUp`) — só então lê o arquivo. Falha no
 * aquecimento nunca lança: cai para [] (0 modelos honesto é melhor que
 * quebrar o connect).
 */
export function makeCodexDiscoverer(
  codexBin = process.env['GITORCH_CODEX_BIN'] ?? 'codex',
  warmUp: (bin: string, home: string) => Promise<void> = defaultCodexWarmUp
): ModelDiscoverer {
  return async (homeDir: string) => {
    const file = path.join(homeDir, '.codex', 'models_cache.json')
    let raw = await fs.readFile(file, 'utf8').catch(() => null)
    if (!raw) {
      await warmUp(codexBin, homeDir).catch(() => undefined)
      raw = await fs.readFile(file, 'utf8').catch(() => null)
    }
    if (!raw) return []
    const parsed = JSON.parse(raw) as { models?: Array<{ slug?: string; display_name?: string }> }
    return (parsed.models ?? [])
      .map((m) => m.display_name || m.slug)
      .filter((m): m is string => Boolean(m))
  }
}

export const discoverCodexModels: ModelDiscoverer = makeCodexDiscoverer()

/**
 * Roda `codex exec` com um prompt mínimo que só pede a palavra "ok" (sem
 * tools) — minimiza tokens gastos. `-s read-only` (não pode alterar nada
 * fora do próprio HOME que o CLI já gerencia); `-C` num diretório vazio
 * dedicado (nem o HOME nem o cwd do processo real) para o modelo não ter
 * nada de real pra explorar; `--skip-git-repo-check` porque esse diretório
 * isolado não é um repo git.
 */
async function defaultCodexWarmUp(bin: string, home: string): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-warmup-'))
  try {
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home }
    await execFileAsync(
      bin,
      [
        'exec',
        'Reply with only the word ok. Do not run any shell commands or tools.',
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '-C',
        cwd,
      ],
      { env, timeout: CODEX_WARMUP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    )
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Claude: a CLI não expõe listagem simples; usa a lista conhecida (mais recente
 * primeiro), sobrescrevível por ambiente (GITORCH_CLAUDE_MODELS, separada por
 * vírgula) para acompanhar lançamentos sem redeploy.
 */
export const discoverClaudeModels: ModelDiscoverer = async () => {
  const env = process.env['GITORCH_CLAUDE_MODELS']
  if (env) {
    return env
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
  }
  return ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
}

export const MODEL_DISCOVERERS: Record<string, ModelDiscoverer> = {
  antigravity: makeAntigravityDiscoverer(),
  codex: discoverCodexModels,
  claude: discoverClaudeModels,
}

async function defaultRunner(bin: string, args: string[], home: string): Promise<string> {
  // XDG_RUNTIME_DIR é necessário para o Antigravity CLI não travar no socket do
  // seu language-server interno (mesma razão do runtime-adapter).
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home }
  if (process.env['XDG_RUNTIME_DIR']) env['XDG_RUNTIME_DIR'] = process.env['XDG_RUNTIME_DIR']
  const pending = execFileAsync(bin, args, {
    env,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  // O agy lê o stdin antes de imprimir; sem EOF ele trava (pipe do Node fica
  // aberto). Fechar o stdin sinaliza o EOF.
  pending.child.stdin?.end()
  const { stdout } = await pending
  return stdout
}
