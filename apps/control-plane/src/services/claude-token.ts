import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Onde o entrypoint da missão materializa o token do Claude dentro do HOME
// (ver connectRawToken/materializeToHome em engine-connection.ts,
// ENGINE_CREDENTIAL_PATHS.claude[1] = '.gitorch/env/CLAUDE_CODE_OAUTH_TOKEN').
// `claude setup-token` gera um valor pra usar como env var, não um arquivo de
// config do CLI — por isso ele mora em .gitorch/env/, não em .claude/.
const TOKEN_RELATIVE_PATH = path.join('.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN')

/**
 * Lê o token OAuth do Claude (`sk-ant-oat01-...`, escopo `user:inference`) do
 * HOME materializado da missão. Compartilhado por quota-reader.ts e
 * model-catalog.ts: os dois precisam do MESMO token pra chamar a API pública
 * da Anthropic (`authorization: Bearer <token>` + `anthropic-beta:
 * oauth-2025-04-20` + `anthropic-version: 2023-06-01`) — é este token, e não
 * uma `.credentials.json` de sessão completa, que o produto realmente
 * captura (ver docs/operations/engine-collection-real-steps.md, provado ao
 * vivo 21/07: `claude -p "/usage"` NÃO funciona com ele).
 *
 * Override por ambiente (GITORCH_CLAUDE_OAUTH_TOKEN) pra teste/staging sem
 * precisar materializar um HOME de verdade — vence o arquivo quando não-vazio.
 * Nunca lança: arquivo ausente, HOME inexistente ou erro de leitura viram
 * `null` (quem chama decide o fallback honesto — nunca aqui).
 */
export async function readClaudeTokenFromHome(homeDir: string): Promise<string | null> {
  const override = process.env['GITORCH_CLAUDE_OAUTH_TOKEN']
  if (override && override.trim()) return override.trim()
  const file = path.join(homeDir, TOKEN_RELATIVE_PATH)
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (raw == null) return null
  const trimmed = raw.trim()
  return trimmed || null
}

// Base da API pública da Anthropic — override por ambiente só existe pra
// mirar um gateway/proxy em teste, nunca usado em produção.
export const CLAUDE_API_BASE = process.env['GITORCH_CLAUDE_API_BASE'] ?? 'https://api.anthropic.com'

// Margem de timeout compartilhada por toda chamada à API do Claude
// (modelos e quota) — nunca segura o connect se a Anthropic estiver
// lenta/fora do ar.
export const CLAUDE_API_TIMEOUT_MS = 20_000

const ANTHROPIC_VERSION = '2023-06-01'
// Beta necessário pra a API aceitar como Bearer um token de `claude
// setup-token` (escopo user:inference) — sem ele a API rejeita o token OAuth
// do CLI com 401. Provado ao vivo 21/07 (docs/operations/engine-collection-
// real-steps.md).
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'

/**
 * Monta os headers de auth pra qualquer chamada à API pública da Anthropic
 * usando o token OAuth do CLI. Único lugar que sabe a FORMA desses headers —
 * quota-reader.ts (POST /v1/messages) e model-catalog.ts (GET /v1/models) os
 * usam sem duplicar a receita. Nunca loga o token — só o devolve dentro do
 * objeto de headers, pra quem chamar usar direto na requisição.
 */
export function claudeApiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': ANTHROPIC_OAUTH_BETA,
    'anthropic-version': ANTHROPIC_VERSION,
  }
}
