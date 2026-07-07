/**
 * Sinais do GitHub para o diagnóstico grátis (F1) — ZERO LLM.
 * Usa a API do GitHub com o token cifrado do usuário (nunca uma chave nossa).
 * Cada chamada degrada sozinha (erro de rede/permissão -> valor neutro), porque
 * o diagnóstico não pode quebrar por causa de um sinal opcional.
 */

export interface GithubSignals {
  /** Issues abertas de verdade (exclui PRs, que a API do GitHub mistura em /issues). */
  openIssues: number
  /** PRs abertos no total. */
  openPullRequests: number
  /** PRs abertos sem atualização há mais de `staleDays` — o "parado". */
  stalePullRequests: number
  /** Saúde do CI pela conclusão do run mais recente concluído. */
  ciHealth: 'passing' | 'failing' | 'unknown'
}

export interface GithubSignalsOptions {
  fetchImpl?: typeof fetch
  /** PR sem update há mais que isto (dias) conta como parado. Default 30. */
  staleDays?: number
  /** Injetável para teste determinístico. Default Date.now(). */
  now?: number
}

interface IssueLike {
  pull_request?: unknown
  updated_at?: string
}
interface PullLike {
  updated_at?: string
}
interface WorkflowRun {
  status?: string
  conclusion?: string | null
  updated_at?: string
}

const GH_API = 'https://api.github.com'

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
  }
}

async function safeJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  fallback: T
): Promise<T> {
  try {
    const res = await fetchImpl(url, { headers: ghHeaders(token) })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    // Sinal opcional: nunca derruba o diagnóstico por causa de rede/permissão.
    return fallback
  }
}

export async function fetchGithubSignals(
  repoFullName: string,
  token: string,
  options: GithubSignalsOptions = {}
): Promise<GithubSignals> {
  const fetchImpl = options.fetchImpl ?? fetch
  const staleDays = options.staleDays ?? 30
  const now = options.now ?? Date.now()
  const staleMs = staleDays * 24 * 60 * 60 * 1000

  const [issues, pulls, runsResp] = await Promise.all([
    safeJson<IssueLike[]>(
      fetchImpl,
      `${GH_API}/repos/${repoFullName}/issues?state=open&per_page=100`,
      token,
      []
    ),
    safeJson<PullLike[]>(
      fetchImpl,
      `${GH_API}/repos/${repoFullName}/pulls?state=open&per_page=100`,
      token,
      []
    ),
    safeJson<{ workflow_runs?: WorkflowRun[] }>(
      fetchImpl,
      `${GH_API}/repos/${repoFullName}/actions/runs?per_page=20`,
      token,
      {}
    ),
  ])

  const issueArr = Array.isArray(issues) ? issues : []
  const pullArr = Array.isArray(pulls) ? pulls : []
  const runs = Array.isArray(runsResp.workflow_runs) ? runsResp.workflow_runs : []

  const openIssues = issueArr.filter((i) => !i.pull_request).length
  const openPullRequests = pullArr.length
  const isStale = (updatedAt?: string): boolean => {
    if (!updatedAt) return false
    const t = Date.parse(updatedAt)
    return Number.isFinite(t) && now - t > staleMs
  }
  const stalePullRequests = pullArr.filter((p) => isStale(p.updated_at)).length

  const latestCompleted = runs
    .filter((r) => r.status === 'completed' && r.conclusion)
    .sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''))[0]
  const ciHealth: GithubSignals['ciHealth'] = !latestCompleted
    ? 'unknown'
    : latestCompleted.conclusion === 'success'
      ? 'passing'
      : 'failing'

  return { openIssues, openPullRequests, stalePullRequests, ciHealth }
}
