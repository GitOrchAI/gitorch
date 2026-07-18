import { sign } from 'node:crypto'

/**
 * Emite installation tokens de vida curta do GitHub App do gitorch (`gitorch-ai`),
 * para o caminho dos TRILHOS (PO/QA/SM) agir no GitHub como o PRÓPRIO gitorch —
 * nunca "pegando emprestado" o PAT de outro projeto por colisão de nome no .env.
 *
 * Contrato de degradação graciosa: qualquer problema (App não configurado, chave
 * inválida, API fora) resolve em `null` — NUNCA lança. O scheduler trata `null`
 * como "trilhos desligados" e cai no caminho clássico com log honesto.
 */

export interface AppTokenDeps {
  /** default: process.env['GITHUB_APP_ID'] */
  appId?: string | undefined
  /** default: process.env['GITHUB_APP_PRIVATE_KEY'] (aceita PEM com \n escapado) */
  privateKey?: string | undefined
  /** injeção para teste; default: fetch global */
  fetchImpl?: typeof fetch
  /** injeção para teste; default: Date.now */
  now?: () => number
  /**
   * Instalação explícita a mintar (ex.: users.github_installation_id do
   * cliente do wizard). Default: comportamento antigo — a PRIMEIRA
   * instalação do App (`installations[0]`), usado pelo caminho dos trilhos,
   * que não sabe (nem precisa saber) o ID de ninguém específico.
   */
  installationId?: number | undefined
}

const GITHUB_API = 'https://api.github.com'
const TIMEOUT_MS = 10_000
const CLOCK_SKEW_MS = 60_000

interface CachedToken {
  token: string
  expiresAtMs: number
}

// Cache POR instalação — um cliente do wizard (installationId explícito) e o
// caminho dos trilhos (installations[0]) nunca devem compartilhar o token um
// do outro. `cachedInstallationId` continua existindo só para o caminho SEM
// installationId explícito, evitando repetir a chamada de listagem a cada
// tick — exatamente o comportamento de antes.
const tokenCacheByInstallation = new Map<number, CachedToken>()
let cachedInstallationId: number | null = null

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url')
}

/** O .env guarda a chave numa linha só com `\n` escapado (às vezes entre aspas). */
function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, '\n').replace(/^"|"$/g, '').trim()
}

function signAppJwt(appId: string, privateKey: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }))
  const data = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(data), normalizePem(privateKey)).toString(
    'base64url'
  )
  return `${data}.${signature}`
}

/**
 * Devolve um installation token do GitHub App do gitorch, ou `null` se o App não
 * estiver configurado/acessível. Faz cache do token até perto de expirar (a API do
 * GitHub emite tokens de ~1h), então o custo de rede é uma vez por hora, não por tick.
 */
export async function mintInstallationToken(deps: AppTokenDeps = {}): Promise<string | null> {
  const appId = deps.appId ?? process.env['GITHUB_APP_ID']
  const privateKey = deps.privateKey ?? process.env['GITHUB_APP_PRIVATE_KEY']
  if (!appId || !privateKey) return null

  const fetchImpl = deps.fetchImpl ?? fetch
  const nowMs = deps.now ? deps.now() : Date.now()

  // Resolve o ID sem tocar rede quando possível: explícito, ou o já
  // descoberto por uma chamada anterior sem installationId.
  let installationId = deps.installationId ?? cachedInstallationId ?? undefined

  if (installationId !== undefined) {
    const cached = tokenCacheByInstallation.get(installationId)
    if (cached && cached.expiresAtMs - CLOCK_SKEW_MS > nowMs) {
      return cached.token
    }
  }

  try {
    const jwt = signAppJwt(appId, privateKey, Math.floor(nowMs / 1000))
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch-control-plane',
      'X-GitHub-Api-Version': '2022-11-28',
    }

    if (installationId === undefined) {
      const res = await fetchImpl(`${GITHUB_API}/app/installations`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        console.warn(
          `[github-app-token] falha ao listar instalações (HTTP ${res.status}) — trilhos ficam desligados`
        )
        return null
      }
      const installations = (await res.json()) as Array<{ id: number }>
      installationId = installations[0]?.id ?? undefined
      if (installationId === undefined) {
        console.warn(
          '[github-app-token] GitHub App sem nenhuma instalação — trilhos ficam desligados'
        )
        return null
      }
      cachedInstallationId = installationId
    }

    const res = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(
        `[github-app-token] falha ao emitir installation token (HTTP ${res.status}) — trilhos ficam desligados`
      )
      return null
    }
    const body = (await res.json()) as { token?: string; expires_at?: string }
    if (!body.token) return null

    const cachedToken: CachedToken = {
      token: body.token,
      expiresAtMs: body.expires_at ? Date.parse(body.expires_at) : nowMs + 55 * 60_000,
    }
    tokenCacheByInstallation.set(installationId, cachedToken)
    return cachedToken.token
  } catch (err) {
    console.warn(
      `[github-app-token] erro ao emitir token do App (${(err as Error).message}) — trilhos ficam desligados`
    )
    return null
  }
}

/** Limpa o cache em memória — usado em testes. */
export function resetAppTokenCache(): void {
  tokenCacheByInstallation.clear()
  cachedInstallationId = null
}
