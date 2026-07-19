// Contrato de erro do wizard (clone dos repos + diagnóstico grátis) —
// espelha apps/control-plane/src/lib/setup-errors.ts (SetupErrorCode). Fica
// FORA de React, testável em node puro (mesmo padrão de engine-status.ts):
// StepSelectRepos, StepDiagnosis e StepReady importam daqui.

export type SetupErrorCode =
  | 'REPO_ACCESS_DENIED'
  | 'REPO_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'DISK_FULL'
  | 'CLONE_TIMEOUT'
  | 'DIAG_TIMEOUT'
  | 'DIAG_EMPTY_REPO'
  | 'GITHUB_TOKEN_EXPIRED'
  | 'INTERNAL'

const SETUP_ERROR_CODES: readonly SetupErrorCode[] = [
  'REPO_ACCESS_DENIED',
  'REPO_NOT_FOUND',
  'RATE_LIMITED',
  'DISK_FULL',
  'CLONE_TIMEOUT',
  'DIAG_TIMEOUT',
  'DIAG_EMPTY_REPO',
  'GITHUB_TOKEN_EXPIRED',
  'INTERNAL',
]

function isSetupErrorCode(value: unknown): value is SetupErrorCode {
  return typeof value === 'string' && (SETUP_ERROR_CODES as string[]).includes(value)
}

/**
 * Corpo de erro de uma rota do wizard (ex.: POST /setup/clone) no formato
 * `{ error, code }`. `code` só é confiável quando é um dos SetupErrorCode
 * conhecidos — uma rota antiga, um proxy no meio do caminho ou um erro de
 * rede caem em `null`, e quem chama usa o fallback genérico de sempre.
 */
export function parseSetupErrorCode(json: unknown): SetupErrorCode | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const code = (json as { code?: unknown }).code
  return isSetupErrorCode(code) ? code : null
}

/**
 * `DiagnosisJob.error` vem no formato "CODE: mensagem" (free-diagnosis.ts).
 * Extrai o code reconhecido; sem prefixo válido (ou job de antes deste PR,
 * sem prefixo nenhum) devolve `null` — o chamador cai no texto cru atual,
 * comportamento inalterado.
 */
export function parseDiagnosisErrorCode(
  jobError: string | null | undefined
): SetupErrorCode | null {
  if (!jobError) return null
  const match = /^([A-Z_]+):\s/.exec(jobError)
  const code = match?.[1]
  return isSetupErrorCode(code) ? code : null
}

// Chave i18n com a dica (problema + causa + solução, curtos) para o code —
// sempre existe (INTERNAL cobre o fallback), então o front nunca mostra uma
// chave em branco/"undefined".
const HINT_KEYS: Record<SetupErrorCode, string> = {
  REPO_ACCESS_DENIED: 'setup.errREPO_ACCESS_DENIED',
  REPO_NOT_FOUND: 'setup.errREPO_NOT_FOUND',
  RATE_LIMITED: 'setup.errRATE_LIMITED',
  DISK_FULL: 'setup.errDISK_FULL',
  CLONE_TIMEOUT: 'setup.errCLONE_TIMEOUT',
  DIAG_TIMEOUT: 'setup.errDIAG_TIMEOUT',
  DIAG_EMPTY_REPO: 'setup.errDIAG_EMPTY_REPO',
  GITHUB_TOKEN_EXPIRED: 'setup.errGITHUB_TOKEN_EXPIRED',
  INTERNAL: 'setup.errINTERNAL',
}

export function setupErrorHintKey(code: SetupErrorCode): string {
  return HINT_KEYS[code]
}
