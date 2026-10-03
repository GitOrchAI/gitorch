import { nomeDeRepositorioValido } from './nome-de-repositorio.js'

export interface ResolverDefaultBranchDeps {
  repoFullName: string
  token?: string | undefined
  fallbackBranch?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

const API_GITHUB = 'https://api.github.com'
const TIMEOUT_MS = 10000

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

  if (!nomeDeRepositorioValido(deps.repoFullName)) {
    return fallback
  }

  const fetchImpl = deps.fetchImpl ?? fetch

  try {
    const resposta = await fetchImpl(`${API_GITHUB}/repos/${deps.repoFullName}`, {
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
