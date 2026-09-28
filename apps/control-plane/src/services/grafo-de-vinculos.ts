import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { ProjectV2Client } from '@gitorch/github-sync'
import { existeSessaoLigada } from './casar-pr-com-sessao.js'
import { MARCA_DO_PARECER } from './parecer-do-qa.js'

/** Só o que `atualizarGrafoDeVinculos` precisa do Prisma. */
export interface PrismaDoGrafoDeVinculos {
  repoItemVinculos: Pick<PrismaClient['repoItemVinculos'], 'upsert'>
  devSession: Pick<PrismaClient['devSession'], 'findMany'>
}

/** Sessão do dev assíncrono, na forma mínima que este coletor precisa (lida
 *  do Prisma — `closedAt` ainda é `Date`, não serializável em JSON). */
export interface SessaoDoGrafo {
  sessionName: string
  issueNumber: number
  pullRequestNumber: number | null
  state: string
  closedAt: Date | null
}

/** A mesma sessão, já na forma JSON-segura gravada em `sessoesJules`
 *  (`closedAt` vira string ISO ou null — `Date` não é um `InputJsonValue`). */
export interface SessaoDoGrafoJson {
  sessionName: string
  issueNumber: number
  pullRequestNumber: number | null
  state: string
  closedAt: string | null
}

function paraJson(sessao: SessaoDoGrafo): SessaoDoGrafoJson {
  return {
    sessionName: sessao.sessionName,
    issueNumber: sessao.issueNumber,
    pullRequestNumber: sessao.pullRequestNumber,
    state: sessao.state,
    closedAt: sessao.closedAt ? sessao.closedAt.toISOString() : null,
  }
}

export interface AtualizarGrafoDeps {
  prisma: PrismaDoGrafoDeVinculos
  githubToken: string
  owner: string
  repo: string
  numero: number
  tipo: 'issue' | 'pr'
  repoItemId: string
  projectId: string
  /** Nome do branch do PR (head.ref) — só relevante para tipo 'pr'; usado
   *  para casar com dev_sessions por sufixo, além do casamento por
   *  pullRequestNumber já gravado. */
  headRefName?: string | undefined
  /** Corpo do PR/issue — usado no recuo "for task [<id>]" do casamento. */
  corpo?: string | undefined
  client?: ProjectV2Client | undefined
}

/**
 * Coleta o grafo completo de vínculos de um item (issue ou PR) via GraphQL
 * (GitHub) + dev_sessions (Prisma), e grava de forma IDEMPOTENTE (upsert por
 * repoItemId — rodar 2x não duplica, só atualiza).
 *
 * Issue #877: esta é a peça que fecha o vínculo do PR #583 → issue #580 →
 * origem jules_gitorch. `sessoesJules` para tipo 'issue' vem de
 * `dev_sessions.issueNumber`; para tipo 'pr' vem de `pullRequestNumber` JÁ
 * gravado OU do casamento por sufixo do branch (`existeSessaoLigada`), pro
 * grafo ficar correto mesmo que a ligação ainda não tenha sido persistida em
 * dev_sessions no instante em que este coletor roda.
 */
export async function atualizarGrafoDeVinculos(deps: AtualizarGrafoDeps): Promise<void> {
  const client = deps.client ?? new ProjectV2Client({ token: deps.githubToken })
  const input = { owner: deps.owner, repo: deps.repo, number: deps.numero, type: deps.tipo }

  const [hierarquia, milestone, projectFields, labelsAndAssignees, prsLigados, checksEReview] =
    await Promise.all([
      deps.tipo === 'issue'
        ? client.getIssueHierarchy({ owner: deps.owner, repo: deps.repo, number: deps.numero })
        : Promise.resolve({ parents: [], subIssues: [] }),
      client.getItemMilestone(input),
      client.getProjectsV2Fields(input),
      client.getItemLabelsAndAssignees(input),
      client.getPullRequestCrossReferences(input),
      deps.tipo === 'pr'
        ? client.getPullRequestChecksAndReview({
            owner: deps.owner,
            repo: deps.repo,
            number: deps.numero,
            marcaDoParecer: MARCA_DO_PARECER,
          })
        : Promise.resolve({ statusCheckRollup: null, qaReview: null }),
    ])

  const sessoesDoProjeto: SessaoDoGrafo[] = await deps.prisma.devSession.findMany({
    where: { projectId: deps.projectId },
    select: {
      sessionName: true,
      issueNumber: true,
      pullRequestNumber: true,
      state: true,
      closedAt: true,
    },
  })

  const sessoesJules: SessaoDoGrafo[] =
    deps.tipo === 'issue'
      ? sessoesDoProjeto.filter((s) => s.issueNumber === deps.numero)
      : sessoesDoProjeto.filter((s) => {
          if (s.pullRequestNumber === deps.numero) return true
          return existeSessaoLigada({
            headRefName: deps.headRefName,
            corpo: deps.corpo,
            sessoes: [{ sessionName: s.sessionName, pullRequestNumber: s.pullRequestNumber }],
          })
        })

  const campos = {
    hierarquia,
    milestone: milestone ?? Prisma.JsonNull,
    projectFields,
    labelsAndAssignees,
    prsLigados,
    // Cast necessário: `SessaoDoGrafoJson` é uma interface nomeada sem index
    // signature, e o TypeScript não a considera atribuível a `InputJsonValue`
    // (que tem index signature) mesmo sendo estruturalmente compatível — só
    // literais de objeto "frescos" escapam dessa checagem. Os dados aqui são
    // JSON-seguros por construção (`paraJson` só produz string/number/null).
    sessoesJules: sessoesJules.map(paraJson) as unknown as Prisma.InputJsonValue,
    qaReview: checksEReview.qaReview ?? Prisma.JsonNull,
    statusCheckRollup: checksEReview.statusCheckRollup ?? Prisma.JsonNull,
  }

  await deps.prisma.repoItemVinculos.upsert({
    where: { repoItemId: deps.repoItemId },
    create: { repoItemId: deps.repoItemId, ...campos },
    update: campos,
  })
}
