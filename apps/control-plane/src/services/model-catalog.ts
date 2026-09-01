import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  readClaudeTokenFromHome,
  CLAUDE_API_BASE,
  CLAUDE_API_TIMEOUT_MS,
  claudeApiHeaders,
} from './claude-token.js'
import {
  codexQuotaFilePath,
  parseCodexRateLimitsFromJsonl,
  writeCodexQuotaFile,
} from './quota-reader.js'
import { estaNaHoraDeColetarCota } from './quando-coletar-cota.js'
import { ehLinhaDeModelo, nomeDeExibicaoDoModelo } from './catalogo-vivo-de-modelos.js'

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

/**
 * Antigravity: `agy models` imprime um modelo por linha, no formato
 * `slug<TAB>Nome de Exibição` — conferido nesta VM em 31/08/2026 com
 * `agy models | cat -A`.
 *
 * O coletor ANTIGO só fazia split+trim e guardava a linha inteira. Resultado
 * medido no banco no mesmo dia: as 14 entradas de `engine_connections.models`
 * do antigravity estavam todas coladas
 * (`'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)'`) — nenhuma delas
 * serviria como valor de `--model`, que aceita o NOME DE EXIBIÇÃO (provado ao
 * vivo: `agy --model "Gemini 3.5 Flash (Medium)"` responde `invalid model
 * selection ... Available models: Gemini 3.7 Flash (High) ...`). O catálogo
 * era bonito na tela e inútil para qualquer decisão — e o teste não pegava
 * porque o fake nunca teve TAB.
 */
export function makeAntigravityDiscoverer(
  agyBin = process.env['GITORCH_AGY_BIN'] ?? 'agy',
  runner: (bin: string, args: string[], home: string) => Promise<string> = defaultRunner
): ModelDiscoverer {
  return async (homeDir: string) => {
    const out = await runner(agyBin, ['models'], homeDir)
    return out.split('\n').filter(ehLinhaDeModelo).map(nomeDeExibicaoDoModelo).filter(Boolean)
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
 *
 * Esse MESMO aquecimento (21/07) também alimenta a quota do Codex: ver o
 * comentário de `defaultCodexWarmUp` abaixo e `readCodexQuota` em
 * quota-reader.ts. Um único `codex exec` por chamada — nunca dois.
 */
export function makeCodexDiscoverer(
  codexBin = process.env['GITORCH_CODEX_BIN'] ?? 'codex',
  warmUp: (bin: string, home: string) => Promise<void> = defaultCodexWarmUp
): ModelDiscoverer {
  return async (homeDir: string) => {
    const file = path.join(homeDir, '.codex', 'models_cache.json')
    let raw = await fs.readFile(file, 'utf8').catch(() => null)

    // A COTA TAMBÉM PEDE O AQUECIMENTO, e é por isso que ela era sempre nula.
    //
    // O evento de limites do Codex só nasce como efeito colateral do
    // aquecimento. Só que o gatilho era "models_cache.json está ausente" — e
    // esse arquivo vive no cofre e volta a cada missão, então NUNCA está
    // ausente. O aquecimento nunca rodava, o arquivo de cota nunca era
    // escrito, e o banco ficava com nulo para sempre (medido: as quatro
    // colunas de cota vazias em 100% das missões).
    //
    // Não reaquecer a cada missão continua certo — reaquecer sempre gastaria a
    // cota do cliente à toa. A saída é separar a pergunta da frequência: de
    // seis em seis horas, quatro chamadas por dia em vez de uma por missão.
    const arquivoDeCota = codexQuotaFilePath(homeDir)
    const idadeDaCota = await fs
      .stat(arquivoDeCota)
      .then((st) => st.mtime)
      .catch(() => null)
    const cotaVencida = estaNaHoraDeColetarCota(idadeDaCota, new Date())

    if (!raw || cotaVencida) {
      // NUNCA engolir em silêncio (achado 21/07): o dono viu "conectado, 0
      // modelos" sem NENHUMA pista do porquê — este catch escondia o erro
      // real (timeout, provider fora do ar, etc.) atrás de um simples `[]`.
      // O connect continua honesto (lista vazia é melhor que quebrar), mas
      // agora o motivo fica visível pra investigar de verdade, não adivinhar.
      await warmUp(codexBin, homeDir).catch((err) => {
        console.warn(
          raw
            ? '[model-catalog] aquecimento do Codex para coletar a cota falhou — cota segue nula'
            : '[model-catalog] aquecimento do Codex falhou — 0 modelos',
          { error: err instanceof Error ? err.message : String(err) }
        )
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

/** Runner injetável do `codex exec --json` (execFile real por padrão; um
 * FAKE nos testes — nunca invoca o binário `codex` de verdade). Devolve o
 * stdout bruto (JSONL) pro warmup extrair o evento `rate_limits`. Separado
 * do `runner` genérico de `defaultRunner` (usado por Antigravity) porque
 * este warmup precisa do stdout — os outros só do texto já pronto. */
export type CodexExecRunner = (
  bin: string,
  args: string[],
  env: Record<string, string>
) => Promise<string>

/**
 * Roda `codex exec --json` com um prompt mínimo que só pede a palavra "ok"
 * (sem tools) — minimiza tokens gastos. `-s read-only` (não pode alterar
 * nada fora do próprio HOME que o CLI já gerencia); `-C` num diretório vazio
 * dedicado (nem o HOME nem o cwd do processo real) para o modelo não ter
 * nada de real pra explorar; `--skip-git-repo-check` porque esse diretório
 * isolado não é um repo git.
 *
 * `--json` (novo 21/07): o MESMO comando que já gera `models_cache.json`
 * (efeito colateral do próprio CLI, ver `makeCodexDiscoverer` acima) agora
 * TAMBÉM emite eventos JSONL no stdout — um deles é `rate_limits`, a única
 * fonte real de quota do Codex (`~/.codex/usage.json` NUNCA existe, provado
 * ao vivo, ver docs/operations/engine-collection-real-steps.md). Extraímos
 * esse evento (`parseCodexRateLimitsFromJsonl`, quota-reader.ts) e gravamos
 * `~/.codex/gitorch-quota.json` (`writeCodexQuotaFile`) pra `readCodexQuota`
 * ler depois. Isto é o ÚNICO `codex exec` do fluxo — NUNCA rodar `codex
 * exec` de novo só pra quota, gastaria a quota do dono em dobro. A escrita
 * do arquivo de quota é best-effort (nunca lança): se o evento não aparecer
 * no stdout (ex.: versão antiga do CLI) ou a escrita falhar, a quota
 * simplesmente fica null depois (mesmo contrato honesto do resto do
 * arquivo) — não derruba o warmup nem o catálogo de modelos.
 */
export async function defaultCodexWarmUp(
  bin: string,
  home: string,
  runner: CodexExecRunner = defaultCodexExecRunner
): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-warmup-'))
  try {
    // RUST_LOG=trace é OBRIGATÓRIO pra quota (achado ao vivo 21/07, ver
    // docs/operations/engine-collection-real-steps.md): o evento `rate_limits`
    // do Codex NÃO sai no stdout do `--json` — vem numa mensagem WebSocket que
    // só o log de trace expõe (no STDERR). Sem isto a quota do Codex é sempre
    // nula (foi exatamente o bug do PR #363, que lia do stdout onde o evento
    // nunca esteve). Os modelos (models_cache.json) nascem independente do log.
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      RUST_LOG: 'trace',
    }
    const output = await runner(
      bin,
      [
        'exec',
        '--json',
        'Reply with only the word ok. Do not run any shell commands or tools.',
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '-C',
        cwd,
      ],
      env
    )
    const event = parseCodexRateLimitsFromJsonl(output)
    if (event) {
      await writeCodexQuotaFile(home, event).catch((err) => {
        console.warn('[model-catalog] gravar gitorch-quota.json falhou — quota do Codex nula', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

// Assim que o stderr acumula o marcador do evento de quota, o processo já
// cumpriu seu papel (models_cache.json + rate_limits nascem CEDO — provado ao
// vivo 21/07: o rate_limits aparece por volta de ~1,2MB de trace). Matamos o
// processo nesse ponto em vez de esperá-lo terminar.
const CODEX_RATE_LIMITS_MARKER = 'codex.rate_limits'
// Teto absoluto de captura: se o marcador não vier (ex.: rede lenta, plano sem
// rate_limits), paramos de acumular em 8MB — o RUST_LOG=trace é uma torrente
// (~1GB se deixado correr, provado ao vivo), então NUNCA bufferizar sem limite.
const CODEX_TRACE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Runner do `codex exec` do warmup. DUAS armadilhas provadas ao vivo (21/07,
 * ver docs/operations/engine-collection-real-steps.md):
 *
 *  1) STDIN: o `codex exec` fica "Reading additional input from stdin..." e
 *     TRAVA até o timeout se o stdin não for fechado — o dono via "0 modelos"
 *     porque o warmup morria no timeout sem gerar nada. `stdio[0]: 'ignore'`
 *     dá EOF imediato no stdin, e o codex prossegue.
 *  2) VOLUME: com RUST_LOG=trace (necessário pra o rate_limits, ver
 *     defaultCodexWarmUp) o stderr é uma TORRENTE — ~1GB se o processo correr
 *     até o fim, estourando qualquer maxBuffer. Mas o models_cache.json e o
 *     evento rate_limits nascem CEDO (~1,2MB). Então: stream o stderr, e assim
 *     que o marcador do rate_limits aparecer, MATA o processo (SIGKILL) e
 *     devolve o que juntou. Cap duro de 8MB caso o marcador nunca venha.
 *
 * Nunca rejeita: qualquer falha vira o buffer acumulado (best-effort — o
 * warmup do model-catalog trata "sem rate_limits" como quota nula, e o
 * models_cache é lido à parte). O timeout é o mesmo teto do warmup.
 */
function defaultCodexExecRunner(
  bin: string,
  args: string[],
  env: Record<string, string>
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(buf)
    }
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      // Achou a quota (vem cedo) OU já bufferizou o teto — em ambos, para.
      if (buf.includes(CODEX_RATE_LIMITS_MARKER) || buf.length >= CODEX_TRACE_MAX_BYTES) finish()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', finish)
    child.on('exit', finish)
    const timer = setTimeout(finish, CODEX_WARMUP_TIMEOUT_MS)
  })
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
