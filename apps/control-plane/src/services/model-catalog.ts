import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  readClaudeTokenFromHome,
  CLAUDE_API_BASE,
  CLAUDE_API_TIMEOUT_MS,
  claudeApiHeaders,
} from './claude-token.js'

const execFileAsync = promisify(execFile)

// Aquecimento do Codex: prompt mínimo e diretivo (sem tools), sandbox
// read-only, timeout curto — nunca segura o connect se o provider estiver
// lento/fora do ar. Reproduzido de verdade nesta VM (2026-07-20) contra o
// codex-cli 0.142.5: ~19s e ~2.4k tokens. Reproduzido de novo em 21/07 (mesma
// VM, mesmo binário): ~7k tokens dessa vez — a variação de reasoning entre
// chamadas é real, então a margem sobe pra 45s (30s era apertado demais para
// o pior caso observado).
const CODEX_WARMUP_TIMEOUT_MS = 45_000

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
      // NUNCA engolir em silêncio (achado 21/07): o dono viu "conectado, 0
      // modelos" sem NENHUMA pista do porquê — este catch escondia o erro
      // real (timeout, provider fora do ar, etc.) atrás de um simples `[]`.
      // O connect continua honesto (lista vazia é melhor que quebrar), mas
      // agora o motivo fica visível pra investigar de verdade, não adivinhar.
      await warmUp(codexBin, homeDir).catch((err) => {
        console.warn('[model-catalog] aquecimento do Codex falhou — 0 modelos', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
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
 * Claude: ÚLTIMO RECURSO quando a API real (ver `makeClaudeModelDiscoverer`
 * abaixo) não está disponível — sem token no homeDir, ou a API fora do ar.
 * Lista CONHECIDA dos modelos reais disponíveis hoje (mais recente primeiro),
 * sobrescrevível por ambiente (GITORCH_CLAUDE_MODELS, separada por vírgula)
 * para acompanhar lançamentos sem redeploy mesmo neste modo degradado.
 *
 * Até 20/07 esta era a fonte PRIMÁRIA (a CLI não expõe nenhum comando de
 * listagem — verificado, não existe `claude models`). Rebaixada a fallback em
 * 21/07: a API pública da Anthropic tem `GET /v1/models`, e o token que o
 * produto já captura (`claude setup-token`, escopo `user:inference`) AUTENTICA
 * essa chamada de verdade — não tem mais motivo pra hardcode ser a fonte
 * principal (ver docs/operations/engine-collection-real-steps.md).
 */
export const knownClaudeModels: ModelDiscoverer = async () => {
  const env = process.env['GITORCH_CLAUDE_MODELS']
  if (env) {
    return env
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
  }
  return ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
}

interface ClaudeModelsResponse {
  data?: Array<{ id?: unknown; display_name?: unknown }>
}

/**
 * Claude: descobre os modelos reais via `GET /v1/models` da API pública da
 * Anthropic — fonte PRIMÁRIA agora (ver comentário de `knownClaudeModels`
 * acima para o porquê da troca). Autentica com o MESMO token que o produto
 * captura do `claude setup-token` (lido do homeDir por
 * `readClaudeTokenFromHome`, ver claude-token.ts).
 *
 * Prova ao vivo 21/07 (docs/operations/engine-collection-real-steps.md):
 * `GET /v1/models?limit=20` devolveu 10 modelos reais desta conta.
 *
 * `fetchImpl`/`readToken` injetáveis (DI, mesmo padrão do resto do arquivo) —
 * nos testes nunca bate rede real nem lê um homeDir de verdade. Contrato
 * honesto: GITORCH_CLAUDE_MODELS (override manual) vence tudo sem tocar rede;
 * sem token no homeDir, resposta não-ok, corpo sem `data`/lista vazia, ou
 * qualquer erro de rede/timeout — cai em `knownClaudeModels` (fallback de
 * último recurso). NUNCA lança.
 */
export function makeClaudeModelDiscoverer(
  fetchImpl: typeof fetch = fetch,
  readToken: (homeDir: string) => Promise<string | null> = readClaudeTokenFromHome
): ModelDiscoverer {
  return async (homeDir: string) => {
    const env = process.env['GITORCH_CLAUDE_MODELS']
    if (env) {
      return env
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    }
    const token = await readToken(homeDir)
    if (!token) return knownClaudeModels(homeDir)
    try {
      const res = await fetchImpl(`${CLAUDE_API_BASE}/v1/models?limit=20`, {
        method: 'GET',
        headers: claudeApiHeaders(token),
        signal: AbortSignal.timeout(CLAUDE_API_TIMEOUT_MS),
      })
      if (!res.ok) {
        console.warn('[model-catalog] GET /v1/models não-ok — caindo na lista conhecida', {
          status: res.status,
        })
        return knownClaudeModels(homeDir)
      }
      const body = (await res.json()) as ClaudeModelsResponse
      const models = (body.data ?? [])
        .map((m) => {
          if (typeof m.display_name === 'string' && m.display_name) return m.display_name
          if (typeof m.id === 'string' && m.id) return m.id
          return null
        })
        .filter((m): m is string => Boolean(m))
      return models.length > 0 ? models : await knownClaudeModels(homeDir)
    } catch (err) {
      console.warn('[model-catalog] GET /v1/models falhou — caindo na lista conhecida', {
        error: err instanceof Error ? err.message : String(err),
      })
      return knownClaudeModels(homeDir)
    }
  }
}

/** Instância real usada em produção (MODEL_DISCOVERERS.claude). */
export const discoverClaudeModels: ModelDiscoverer = makeClaudeModelDiscoverer()

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
