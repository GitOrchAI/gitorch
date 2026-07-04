import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

/** Codex: lê ~/.codex/models_cache.json (models[].display_name || slug). */
export const discoverCodexModels: ModelDiscoverer = async (homeDir: string) => {
  const file = path.join(homeDir, '.codex', 'models_cache.json')
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (!raw) return []
  const parsed = JSON.parse(raw) as { models?: Array<{ slug?: string; display_name?: string }> }
  return (parsed.models ?? [])
    .map((m) => m.display_name || m.slug)
    .filter((m): m is string => Boolean(m))
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
