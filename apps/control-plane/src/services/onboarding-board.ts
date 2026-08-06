import type { ProjectV2Client } from '@gitorch/github-sync'

// A mesa de trabalho do PRÓPRIO projeto (Task 9). Antes disto o board vinha de
// um env GLOBAL (GITORCH_PROJECT_BOARD), o que fazia todo projeto novo apontar
// para o board global de outro projeto do dono. Um projeto novo precisa da
// própria mesa antes de o PO acordar — board gravado no próprio projeto
// (Project.runtimeConfig). Sem board próprio, os trilhos do PO ficam
// desligados: nunca há fallback para o board global de outro projeto.

export type GithubOwnerType = 'user' | 'organization'

export interface ResolvedOwner {
  /** Node id GraphQL do dono (user ou organization) — o que createProjectV2 pede. */
  id: string
  type: GithubOwnerType
}

export interface EnsureProjectBoardDeps {
  /** 'dono/repo' do projeto, como gravado em Project.wingId. */
  repository: string
  client: Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2'>
  /** Resolve o node id + tipo (user ou organization) do dono no GitHub. */
  resolveOwner: (owner: string) => Promise<ResolvedOwner>
  /** Número do board já conhecido do projeto, quando houver. */
  existingNumber?: number
  onWarn?: (message: string) => void
}

export interface ProjectBoardRef {
  owner: string
  number: number
}

/**
 * Garante que o projeto tem seu PRÓPRIO board Projects v2: cria na primeira
 * vez, reaproveita se `existingNumber` ainda existir no GitHub.
 *
 * NUNCA lança. Risco conhecido: quem chama esta função no provisionamento do
 * wizard usa o token OAuth do PRÓPRIO dono do projeto (não um installation
 * token do GitHub App) — criar board de ORGANIZAÇÃO pode exigir um escopo que
 * aquele OAuth não tem e devolver "Resource not accessible by integration".
 * Se isso acontecer em produção, o certo é avisar e seguir: sem board o PO
 * ainda entrega o roadmap na memória, o que se perde é só o quadro. Derrubar
 * o provisionamento inteiro por isso seria pior que o problema que resolve —
 * mas nunca em silêncio (`onWarn` é chamado sempre).
 */
export async function ensureProjectBoard(
  deps: EnsureProjectBoardDeps
): Promise<ProjectBoardRef | null> {
  const owner = deps.repository.split('/')[0] ?? ''
  const warn = deps.onWarn ?? (() => undefined)

  if (!owner) {
    warn(`nao foi possivel derivar o dono do board a partir de '${deps.repository}'`)
    return null
  }

  try {
    const resolved = await deps.resolveOwner(owner)

    if (deps.existingNumber !== undefined) {
      const existente = await deps.client.findProjectId({
        login: owner,
        number: deps.existingNumber,
        ownerType: resolved.type,
      })
      if (existente) return { owner, number: deps.existingNumber }
    }

    const criado = await deps.client.createProjectV2({
      ownerId: resolved.id,
      title: deps.repository,
    })
    return { owner, number: criado.number }
  } catch (err) {
    warn(`falha ao garantir o board do projeto ${deps.repository}: ${(err as Error).message}`)
    return null
  }
}

const GITHUB_API = 'https://api.github.com'

export interface ResolveGithubOwnerIdDeps {
  /** injeção para teste; default: fetch global. */
  fetchImpl?: typeof fetch
}

/**
 * Resolve o node id GraphQL + tipo do dono de um repositório no GitHub.
 * Tenta `GET /users/{owner}` primeiro (cobre conta pessoal); se não achar,
 * cai para `GET /orgs/{owner}` (organização). Precisa dos dois caminhos
 * porque o dono do board pode ser qualquer um dos dois.
 */
export async function resolveGithubOwnerId(
  owner: string,
  token: string,
  deps: ResolveGithubOwnerIdDeps = {}
): Promise<ResolvedOwner> {
  const f = deps.fetchImpl ?? fetch
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
  }

  const userRes = await f(`${GITHUB_API}/users/${owner}`, { headers })
  if (userRes.ok) {
    const data = (await userRes.json()) as { node_id: string; type?: string }
    return { id: data.node_id, type: data.type === 'Organization' ? 'organization' : 'user' }
  }

  const orgRes = await f(`${GITHUB_API}/orgs/${owner}`, { headers })
  if (orgRes.ok) {
    const data = (await orgRes.json()) as { node_id: string }
    return { id: data.node_id, type: 'organization' }
  }

  throw new Error(
    `nao foi possivel resolver o dono '${owner}' no GitHub (HTTP ${userRes.status} em /users, ${orgRes.status} em /orgs)`
  )
}
