import type { CortexClient, CortexDrawer } from '@gitorch/cortex'
import type { GraphQLTransport } from '@gitorch/github-sync'
import {
  RepoContextCollector,
  buildGithubGraphQLTransport,
  type CollectedRepoContext,
  type CollectedWorkItem,
} from './repo-context-collector.js'
import type { DividaDeSeguranca } from './security-debt-collector.js'

// Só o que a ponte usa do Cortex — permite injetar um fake nos testes.
type CortexWriter = Pick<CortexClient, 'writeDrawer'>

export interface CollectAndRememberDeps {
  token: string
  /** wingId do projeto ("owner/repo") — isola a memória por projeto. */
  wingId: string
  cortex: CortexWriter
  /** número do board GitOrch já conhecido (evita criar 2x); ausente → cria. */
  boardNumber?: number
  /** Credencial do cliente — só ela alcança as rotas de segurança (o App do
   *  produto recebe 403). Ausente/null: o retrato sai sem a dívida de
   *  segurança, sem falhar (mesmo contrato best-effort do collector). */
  clientToken?: string | null
  /** transporte GraphQL injetável (testes). */
  request?: GraphQLTransport
  fetchImpl?: typeof fetch
  /** relógio injetável (testes determinísticos). */
  now?: () => string
}

export interface CollectAndRememberResult {
  collected: boolean
  boardNumber?: number
  boardCreated?: boolean
  prCount?: number
  issueCount?: number
  /** motivo quando collected=false (best-effort não lança; sinaliza aqui). */
  reason?: string
}

/**
 * Ponte GitHub → memória: no aceite final do wizard, coleta o contexto do repo
 * (board Projects V2, criando se ausente, + PRs + Issues) e o grava no Cortex
 * como gavetas (drawers) carimbadas pelo wingId do projeto.
 *
 * BEST-EFFORT por contrato: NUNCA lança. O aceite final não pode quebrar por
 * causa de contexto — se o token não tem escopo de project, a API falha, ou o
 * repo sumiu, devolve { collected: false, reason } e o cliente fica fixado do
 * mesmo jeito. O erro fica no `reason` (quem chama loga), nunca mascarado.
 */
export async function collectAndRememberRepoContext(
  deps: CollectAndRememberDeps
): Promise<CollectAndRememberResult> {
  const [owner, repo] = deps.wingId.split('/')
  if (!owner || !repo) {
    return { collected: false, reason: `wingId inválido (esperado "owner/repo"): ${deps.wingId}` }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const request = deps.request ?? buildGithubGraphQLTransport(fetchImpl)
  const now = deps.now ?? (() => new Date().toISOString())

  try {
    // O board pendura no DONO do repo (user/org) — o collector precisa do node
    // id + tipo para criá-lo. Uma query resolve os dois.
    const ownerInfo = await resolveRepoOwner(request, deps.token, owner, repo)
    if (!ownerInfo) {
      return { collected: false, reason: `dono do repo ${deps.wingId} não resolvido` }
    }

    // `fetchImpl` também vai para o collector (não só para montar o
    // transporte GraphQL padrão): é ele quem coletarDividaDeSeguranca usa
    // para as chamadas REST das rotas de segurança — sem repassar, um
    // fetchImpl de teste nunca alcançaria essa parte da coleta.
    const collector = new RepoContextCollector({ token: deps.token, request, fetchImpl })
    const context = await collector.collect({
      owner,
      repo,
      ownerType: ownerInfo.ownerType,
      ownerId: ownerInfo.ownerId,
      ...(deps.boardNumber !== undefined ? { boardNumber: deps.boardNumber } : {}),
      clientToken: deps.clientToken,
    })

    await rememberRepoContext(deps.cortex, deps.wingId, context, now)

    return {
      collected: true,
      boardNumber: context.board.number,
      boardCreated: context.board.created,
      prCount: context.pullRequests.length,
      issueCount: context.issues.length,
    }
  } catch (err) {
    return { collected: false, reason: (err as Error).message }
  }
}

/**
 * Transforma o contexto coletado em gavetas do Cortex e as grava. Uma gaveta
 * por PR e por Issue + uma de resumo do board. Ids DETERMINÍSTICOS
 * (`github:<wingId>:<tipo>:<número>`): writeDrawer faz upsert, então recoletar
 * ATUALIZA a gaveta em vez de duplicar — a memória não polui em re-submissões.
 */
export async function rememberRepoContext(
  cortex: CortexWriter,
  wingId: string,
  context: CollectedRepoContext,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const ts = now()
  const drawers: CortexDrawer[] = [
    baseDrawer({
      id: `github:${wingId}:board`,
      wingId,
      ts,
      content: `Board GitOrch (GitHub Projects V2 #${context.board.number}) do repositório ${wingId}.`,
      tags: ['github', 'board', 'onboarding'],
      importance: 0.4,
    }),
    ...context.pullRequests.map((pr) => workItemDrawer(wingId, ts, 'pull-request', 'PR', pr)),
    ...context.issues.map((issue) => workItemDrawer(wingId, ts, 'issue', 'Issue', issue)),
    // Ausente quando o contexto não trouxe dívida de segurança (sem
    // credencial do cliente) — a gaveta só existe quando há retrato de
    // verdade pra guardar.
    ...(context.dividaDeSeguranca
      ? [securityDebtDrawer(wingId, ts, context.dividaDeSeguranca)]
      : []),
  ]

  for (const drawer of drawers) {
    await cortex.writeDrawer(drawer)
  }
}

async function resolveRepoOwner(
  request: GraphQLTransport,
  token: string,
  owner: string,
  repo: string
): Promise<{ ownerId: string; ownerType: 'user' | 'organization' } | null> {
  const response = await request<{
    repository: { owner: { id: string; __typename: string } } | null
  }>(
    {
      query: `
        query RepoOwner($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            owner { id __typename }
          }
        }
      `,
      variables: { owner, repo },
    },
    token
  )

  if (response.errors && response.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL request failed: ${response.errors.map((e) => e.message).join('; ')}`
    )
  }
  const repoOwner = response.data?.repository?.owner
  if (!repoOwner) return null
  return {
    ownerId: repoOwner.id,
    ownerType: repoOwner.__typename === 'Organization' ? 'organization' : 'user',
  }
}

function workItemDrawer(
  wingId: string,
  ts: string,
  kind: 'pull-request' | 'issue',
  label: string,
  item: CollectedWorkItem
): CortexDrawer {
  const author = item.author ? `autor ${item.author}` : 'autor desconhecido'
  return baseDrawer({
    id: `github:${wingId}:${kind}:${item.number}`,
    wingId,
    ts,
    content: `${label} #${item.number} "${item.title}" — estado ${item.state}, ${author}, atualizado ${item.updatedAt} (${item.url}).`,
    tags: ['github', kind, item.state.toLowerCase()],
    importance: 0.5,
  })
}

// A dívida de segurança vira UMA gaveta (não uma por alerta): é um retrato de
// um momento, não um item de trabalho isolado como PR/Issue. O resumo por
// severidade entra no texto para o Cortex achar isso sem parsear JSON depois.
// O que não deu para verificar precisa aparecer no texto também: dizer que
// não há alerta quando ninguém conseguiu olhar seria mentir por omissão — a
// memória tem que distinguir "verificado, zero encontrado" de "não sei".
function securityDebtDrawer(wingId: string, ts: string, divida: DividaDeSeguranca): CortexDrawer {
  const total = divida.alertas.length
  const p = divida.porSeveridade
  const resumo = `${total} alerta(s) aberto(s): ${p.critical} crítico(s), ${p.high} alto(s), ${p.medium} médio(s), ${p.low} baixo(s).`
  const aviso =
    divida.naoVerificado.length > 0
      ? ` Não verificado (retrato pode estar incompleto): ${divida.naoVerificado.join(', ')}.`
      : ''
  const listaAlertas = divida.alertas
    .map((a) => `#${a.numero} ${a.pacote} (${a.severidade})`)
    .join('; ')
  const content = `${resumo}${aviso}${listaAlertas ? ` Alertas: ${listaAlertas}.` : ''}`
  return baseDrawer({
    id: `github:${wingId}:divida-de-seguranca`,
    wingId,
    ts,
    content,
    tags: ['github', 'seguranca', 'onboarding'],
    // Alerta crítico aberto pesa mais que o board/PR/Issue rotineiros — é o
    // tipo de fato que a esteira não pode deixar afundar na memória.
    importance: p.critical > 0 ? 0.8 : 0.5,
  })
}

// Molde comum das gavetas de contexto GitHub: mesma sala/corredor, peso
// emocional zero (fato objetivo), confiança alta (veio direto da API).
function baseDrawer(params: {
  id: string
  wingId: string
  ts: string
  content: string
  tags: string[]
  importance: number
}): CortexDrawer {
  return {
    id: params.id,
    wingId: params.wingId,
    roomId: 'contexto-github',
    hallId: 'onboarding',
    content: params.content,
    importance: params.importance,
    emotionalWeight: 0,
    createdAt: params.ts,
    validFrom: params.ts,
    confidence: 0.9,
    tags: params.tags,
  }
}
