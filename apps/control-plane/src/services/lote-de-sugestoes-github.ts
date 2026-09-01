// Os dois adaptadores REAIS de rede do D7 (parte A) — listar issues abertas e
// fechar/comentar uma issue. Separados de lote-de-sugestoes.ts e
// aplicar-lote-de-sugestoes.ts de propósito: aqueles são regra pura,
// testável sem rede; só este arquivo toca `fetch`.
import type { IssueParaDiagnostico } from './diagnostico-de-issues.js'

const GITHUB_API = 'https://api.github.com'

function cabecalhos(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
  }
}

interface IssueBrutaDoGithub {
  number: number
  title: string
  body: string | null
  created_at: string
  updated_at: string
  labels?: Array<{ name?: string } | string>
  pull_request?: unknown
}

export interface DepsDeIssuesAbertas {
  fetchImpl?: typeof fetch
  /** Teto de páginas de 100 — mesmo valor-espírito de descobrirQuadrosPorIssues. */
  maxPaginas?: number
}

/**
 * Lista TODAS as issues ABERTAS de um repositório, paginando até a página
 * ficar vazia (ou até o teto) — nunca só as 100 primeiras em silêncio, a
 * mesma lei que rege o teto do lote em si. HTTP não-ok LANÇA: uma listagem
 * incompleta que segue como se fosse completa é o "default vazio que mente"
 * que já custou caro neste produto.
 *
 * A API de issues do GitHub devolve pull requests junto — descartados aqui
 * (`pull_request` presente = é PR, não issue).
 */
export async function listarIssuesAbertasReal(
  repo: string,
  token: string,
  deps: DepsDeIssuesAbertas = {}
): Promise<IssueParaDiagnostico[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const maxPaginas = deps.maxPaginas ?? 10
  const issues: IssueParaDiagnostico[] = []

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${repo}/issues?state=open&per_page=100&page=${pagina}`,
      { headers: cabecalhos(token) }
    )
    if (!res.ok) {
      throw new Error(`GitHub GET /repos/${repo}/issues HTTP ${res.status} (página ${pagina})`)
    }
    const paginaDeIssues = (await res.json()) as IssueBrutaDoGithub[]
    if (paginaDeIssues.length === 0) break

    for (const bruta of paginaDeIssues) {
      if (bruta.pull_request) continue
      issues.push({
        number: bruta.number,
        title: bruta.title,
        body: bruta.body,
        createdAt: bruta.created_at,
        updatedAt: bruta.updated_at,
        labels: (bruta.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
      })
    }

    if (paginaDeIssues.length < 100) break
  }

  return issues
}

/**
 * Fecha a issue (`state: closed`) e comenta o motivo — a MESMA forma que
 * scheduler.ts já usa em `fecharIssue` (fechar-incidente-resolvido). O PATCH
 * que falha LANÇA (a issue não foi fechada de verdade — quem chama precisa
 * saber). O comentário é best-effort, como no original: o fechamento já
 * aconteceu, e falhar em avisar por escrito não deveria desfazer isso.
 */
export async function fecharIssueReal(
  repo: string,
  issueNumber: number,
  comentario: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const headers = { ...cabecalhos(token), 'Content-Type': 'application/json' }

  const patchRes = await fetchImpl(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  })
  if (!patchRes.ok) {
    throw new Error(
      `GitHub PATCH /repos/${repo}/issues/${issueNumber} HTTP ${patchRes.status} — issue NÃO fechada`
    )
  }

  try {
    await fetchImpl(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: comentario }),
    })
  } catch {
    // Best-effort: o fechamento (que importa) já aconteceu.
  }
}
