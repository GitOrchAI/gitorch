/**
 * Contrato de erro ponta-a-ponta do wizard (clone dos repos + diagnóstico
 * grátis). Cada falha carrega um `code` ESTÁVEL, além da mensagem legível —
 * o frontend escolhe a dica traduzida pelo `code` (nunca pela mensagem crua:
 * ela muda de idioma/formato entre versões do git e não é contrato de nada).
 *
 * As duas funções de classificação mapeiam mensagens REAIS confirmadas ao
 * vivo contra o git/GitHub (ver packages/workspace-engine/src/local-provider.ts
 * e os testes deste arquivo) — nunca um texto inventado que o git não produz.
 */
export type SetupErrorCode =
  | 'REPO_ACCESS_DENIED'
  | 'REPO_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'DISK_FULL'
  | 'CLONE_TIMEOUT'
  | 'DIAG_TIMEOUT'
  | 'DIAG_EMPTY_REPO'
  | 'INTERNAL'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function matches(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(message))
}

// Credencial inválida/expirada — MESMOS padrões que
// LocalWorkspaceProvider.isAuthError usa pra decidir a retentativa anônima
// (mensagem real: "remote: Invalid username or token...\nfatal: Authentication
// failed for ...", confirmada ao vivo).
const AUTH_PATTERNS = [
  /authentication failed/i,
  /invalid username or token/i,
  /could not read username/i,
  /terminal prompts disabled/i,
] as const

// O transporte HTTP do git às vezes reporta o status HTTP cru da falha (SSO
// de org, repositório com acesso suspenso) — "The requested URL returned
// error: 403/404" é formato real e documentado do git-over-https.
const FORBIDDEN_PATTERNS = [/error:\s*403\b/i] as const
const NOT_FOUND_PATTERNS = [/repository not found/i, /error:\s*404\b/i, /\bnot found\b/i] as const
const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /\b429\b/i] as const
const DISK_FULL_PATTERNS = [/enospc/i, /no space left on device/i] as const
// GitHub devolve 409 "Git Repository is empty." em várias rotas da API REST
// para um repo sem nenhum commit; o próprio git avisa "You appear to have
// cloned an empty repository." no clone de um repo assim — os dois são
// mensagens reais, não inventadas.
const EMPTY_REPO_PATTERNS = [/repository is empty/i, /cloned an empty repository/i] as const

/**
 * child_process (execFile/exec com `timeout`) mata o processo por estouro de
 * prazo SEM escrever "timeout" na mensagem — só `killed`/`signal` denunciam
 * (confirmado experimentalmente: a mensagem fica só "Command failed: ...\n").
 * `sanitizeGitError` (local-provider.ts) preserva essas duas propriedades no
 * Error sanitizado especificamente para isto.
 */
function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null } | null
  if (e && (e.killed === true || (typeof e.signal === 'string' && e.signal.length > 0))) {
    return true
  }
  return /timed out|timeout|etimedout/i.test(errorMessage(err))
}

/**
 * Classifica uma falha REAL do LocalWorkspaceProvider/git no clone dos repos
 * escolhidos (POST /api/v1/setup/clone). ENOSPC pode vir tanto do `fs.mkdir`
 * (código nativo `err.code`) quanto do próprio git escrevendo em disco cheio
 * (mensagem de stderr) — os dois são checados.
 */
export function classifyCloneError(err: unknown): SetupErrorCode {
  const message = errorMessage(err)
  const nodeErr = err as NodeJS.ErrnoException | null
  if (nodeErr?.code === 'ENOSPC' || matches(message, DISK_FULL_PATTERNS)) return 'DISK_FULL'
  if (isTimeout(err)) return 'CLONE_TIMEOUT'
  if (matches(message, AUTH_PATTERNS) || matches(message, FORBIDDEN_PATTERNS)) {
    return 'REPO_ACCESS_DENIED'
  }
  if (matches(message, RATE_LIMIT_PATTERNS)) return 'RATE_LIMITED'
  if (matches(message, NOT_FOUND_PATTERNS)) return 'REPO_NOT_FOUND'
  return 'INTERNAL'
}

/**
 * Classifica uma falha do diagnóstico grátis (free-diagnosis.ts): a mesma
 * etapa de clone acontece aqui dentro, então reusa classifyCloneError como
 * base — mas timeout ganha um code PRÓPRIO (DIAG_TIMEOUT em vez de
 * CLONE_TIMEOUT): do ponto de vista do cliente ele está "lendo" o repo, não
 * "clonando pro projeto", e a dica certa muda. "Repositório vazio" também é
 * específico do diagnóstico (DIAG_EMPTY_REPO) — não existe equivalente no
 * fluxo de clone do passo 4.
 */
export function classifyDiagnosisError(err: unknown): SetupErrorCode {
  const message = errorMessage(err)
  if (matches(message, EMPTY_REPO_PATTERNS)) return 'DIAG_EMPTY_REPO'
  const cloneCode = classifyCloneError(err)
  return cloneCode === 'CLONE_TIMEOUT' ? 'DIAG_TIMEOUT' : cloneCode
}

/**
 * Status HTTP para cada code — sempre um corpo DECORADO `{error, code}`,
 * nunca um 500 cru sem classificação. Causas do CLIENTE (acesso, não
 * encontrado, rate limit) ficam em 4xx de verdade; timeout/disco cheio são
 * 5xx (a causa é nossa/da rede), mas ainda assim com `code` estável — o
 * frontend nunca precisa adivinhar a partir de uma mensagem.
 */
export function setupErrorHttpStatus(code: SetupErrorCode): number {
  switch (code) {
    case 'REPO_ACCESS_DENIED':
      return 403
    case 'REPO_NOT_FOUND':
      return 404
    case 'RATE_LIMITED':
      return 429
    case 'DIAG_EMPTY_REPO':
      return 422
    case 'CLONE_TIMEOUT':
    case 'DIAG_TIMEOUT':
      return 504
    case 'DISK_FULL':
      return 507
    case 'INTERNAL':
    default:
      return 500
  }
}
