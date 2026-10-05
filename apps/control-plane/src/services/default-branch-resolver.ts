export interface ResolverDefaultBranchDeps {
  repoFullName: string
  token?: string | undefined
  fallbackBranch?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

const API_GITHUB = 'https://api.github.com'
const HOST_API_GITHUB = 'api.github.com'
const TIMEOUT_MS = 10000

/** Um segmento do nome (dono ou repositório): só letras, números, `.`, `_` e `-`. */
const SEGMENTO = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Monta a URL de `GET /repos/{dono}/{repo}` e SÓ a devolve se ela apontar,
 * de fato, para `https://api.github.com`. Qualquer outra coisa é `null`.
 *
 * Esta é a guarda da porta de saída (o dado vem do cliente no wizard e a
 * chamada leva a credencial no cabeçalho): formato exato "dono/repo",
 * segmentos codificados, e conferência da URL FINAL por igualdade exata de
 * protocolo, host e porta — nunca `startsWith`/`includes`.
 */
export function urlDoRepositorioNoGithub(
  repoFullName: string,
  base: string = API_GITHUB
): URL | null {
  if (typeof repoFullName !== 'string') return null
  const partes = repoFullName.split('/')
  if (partes.length !== 2) return null
  const [dono, repo] = partes as [string, string]
  for (const parte of [dono, repo]) {
    if (!SEGMENTO.test(parte) || parte === '.' || parte === '..' || parte.includes('..')) {
      return null
    }
  }

  let url: URL
  try {
    url = new URL(`/repos/${encodeURIComponent(dono)}/${encodeURIComponent(repo)}`, base)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.host !== HOST_API_GITHUB) return null
  return url
}

function cabecalhos(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

/**
 * Resolve dinamicamente a branch padrão do repositório no GitHub
 * (ex.: 'main', 'master', 'develop').
 *
 * Em caso de falha de rede, erro HTTP da API ou formato inesperado,
 * devolve com segurança o fallbackBranch informado ou 'main'.
 */
export async function resolverDefaultBranch(deps: ResolverDefaultBranchDeps): Promise<string> {
  const fallback = deps.fallbackBranch ?? 'main'

  const url = urlDoRepositorioNoGithub(deps.repoFullName)
  if (url === null) {
    return fallback
  }

  const fetchImpl = deps.fetchImpl ?? fetch

  try {
    // Conferência na própria porta de saída, imediatamente antes do fetch: a
    // credencial só sai para https://api.github.com (igualdade exata).
    if (url.protocol !== 'https:' || url.host !== HOST_API_GITHUB) {
      return fallback
    }
    const resposta = await fetchImpl(url.href, {
      headers: cabecalhos(deps.token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!resposta.ok) {
      return fallback
    }

    const corpo: unknown = await resposta.json().catch(() => null)
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
      return fallback
    }

    const defaultBranch = (corpo as Record<string, unknown>)['default_branch']
    if (typeof defaultBranch === 'string' && defaultBranch.trim().length > 0) {
      return defaultBranch.trim()
    }

    return fallback
  } catch {
    return fallback
  }
}
