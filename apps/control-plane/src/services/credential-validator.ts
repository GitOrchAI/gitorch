// Validação de FORMA da credencial colada manualmente (paste flow) — a barreira
// que faltava ANTES da validação viva (checkLiveness) nos caminhos NÃO-confiáveis
// (connectFileCredential / connectRawToken).
//
// Por que aqui, e não só na liveness: a liveness roda um comando "hello-world" do
// CLI (codex login status / claude auth status / agy models). Rodando de VERDADE
// nesta VM (observado em 2026-07-13) descobrimos que, para o Codex e o Claude,
// esses comandos só provam PRESENÇA de credencial, não VALIDADE:
//   - `codex login status`  → exit 0 "Logged in using ChatGPT" para QUALQUER
//     auth.json que seja JSON parseável (mesmo `{"fake":"qualquer coisa"}`).
//   - `claude auth status`  → exit 0 {"loggedIn":true,"authMethod":"oauth_token"}
//     para QUALQUER valor não-vazio em CLAUDE_CODE_OAUTH_TOKEN (mesmo "lixo").
//   - `agy models` (Antigravity) → exit 1 para token falso: é o ÚNICO que faz um
//     round-trip REAL ao servidor. Por isso o Antigravity não precisa desta
//     checagem — a liveness dele já é honesta.
// Um round-trip real e barato NÃO está disponível para os outros dois: o token do
// Codex é ChatGPT-OAuth (não autentica na API pública da OpenAI; o backend do
// ChatGPT é indocumentado e sensível a ToS) e o token OAuth do Claude (sk-ant-oat)
// toma 401 na API pública /v1/models. Então a defesa possível e HONESTA é rejeitar,
// na porta, o que estruturalmente não é uma credencial real do provider — que é
// exatamente o erro humano comum (colar o arquivo/valor errado). Um token
// bem-formado porém revogado ainda passaria por aqui: esse é o teto documentado
// desta checagem, não um esquecimento.
//
// Contrato: retorna `null` quando o conteúdo é estruturalmente plausível para o
// runtime, ou uma mensagem de erro curta em PT-BR (ela vira o corpo do 400 da rota
// POST /engines/:runtime/token, então precisa ser acionável pro usuário). NUNCA
// loga nem ecoa o conteúdo colado.

export type CredentialKind = 'file' | 'raw'

// Prefixo do token que o `claude setup-token` emite (materializado como env var
// CLAUDE_CODE_OAUTH_TOKEN). Sobrescrevível por ambiente para acompanhar uma
// eventual mudança de formato do provider sem redeploy — mesmo padrão dos
// GITORCH_*_BIN da liveness. Vazio/whitespace conta como NÃO-setado (usa o
// default): um prefixo vazio faria `startsWith('')` ser sempre true e reabriria
// o buraco do "lixo → Conectado" que este módulo fecha — `??` sozinho não pegaria
// a string vazia.
const CLAUDE_TOKEN_PREFIX =
  (process.env['GITORCH_CLAUDE_TOKEN_PREFIX'] ?? '').trim() || 'sk-ant-oat'

/**
 * Valida a FORMA de uma credencial colada para `runtime`. Retorna `null` se é
 * plausível (segue pra liveness), ou uma mensagem de erro se claramente não é
 * uma credencial real do provider.
 */
export function validatePastedCredential(
  runtime: string,
  kind: CredentialKind,
  content: string
): string | null {
  switch (runtime) {
    case 'codex':
      return validateCodexAuthJson(content)
    case 'claude':
      return kind === 'raw'
        ? validateClaudeSetupToken(content)
        : validateClaudeCredentialsJson(content)
    // Antigravity: `agy models` (liveness) já faz o round-trip real e reprova
    // token falso; o formato do arquivo não é documentado, então checar forma
    // aqui só arriscaria falso-negativo. A liveness honesta decide.
    case 'antigravity':
      return null
    // Runtime sem regra específica: não bloqueia por forma. O guard de "runtime
    // não suportado" a montante já barra desconhecidos; a liveness decide o resto.
    default:
      return null
  }
}

type ParseResult = { ok: true; obj: Record<string, unknown> } | { ok: false; error: string }

function parseObject(content: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, error: 'esperado JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'esperado um objeto JSON' }
  }
  return { ok: true, obj: parsed as Record<string, unknown> }
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Lê `obj[key]` só se `obj[key]` for um objeto (não array/null). */
function nestedObject(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = obj[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Codex `~/.codex/auth.json`: precisa de `OPENAI_API_KEY` (modo apikey) OU de
 * `tokens.access_token` (modo chatgpt). `{"fake":"x"}`, `{}` e `{"tokens":{}}`
 * não são credenciais reais — reprovam.
 */
function validateCodexAuthJson(content: string): string | null {
  const res = parseObject(content)
  if (!res.ok) return `credencial de codex inválida: ${res.error} (auth.json)`
  const apiKey = res.obj['OPENAI_API_KEY']
  const accessToken = nestedObject(res.obj, 'tokens')?.['access_token']
  if (nonEmptyString(apiKey) || nonEmptyString(accessToken)) return null
  return 'credencial de codex inválida: auth.json sem tokens.access_token nem OPENAI_API_KEY — cole o conteúdo de ~/.codex/auth.json'
}

/**
 * Claude `setup-token` (materializado como env CLAUDE_CODE_OAUTH_TOKEN): token
 * opaco com prefixo conhecido. "lixo-fake-token" reprova.
 */
function validateClaudeSetupToken(content: string): string | null {
  const t = content.trim()
  if (t.startsWith(CLAUDE_TOKEN_PREFIX) && t.length >= CLAUDE_TOKEN_PREFIX.length + 4) return null
  return `token de claude inválido: esperado o token do 'claude setup-token' (começa com ${CLAUDE_TOKEN_PREFIX})`
}

/**
 * Claude `~/.claude/.credentials.json` (caminho de ARQUIVO — defesa em
 * profundidade; o wizard usa o setup-token acima): precisa de
 * `claudeAiOauth.accessToken`.
 */
function validateClaudeCredentialsJson(content: string): string | null {
  const res = parseObject(content)
  if (!res.ok) return `credencial de claude inválida: ${res.error} (.credentials.json)`
  const accessToken = nestedObject(res.obj, 'claudeAiOauth')?.['accessToken']
  if (nonEmptyString(accessToken)) return null
  return 'credencial de claude inválida: .credentials.json sem claudeAiOauth.accessToken'
}
