import type { PrismaClient } from '@prisma/client'
import { ProjectV2Client } from '@gitorch/github-sync'

export interface AtualizarGrafoDeps {
  prisma: Pick<PrismaClient, 'repoItem' | 'repoItemVinculos'>
  githubToken: string
  owner: string
  repo: string
  numero: number
  tipo: 'issue' | 'pr'
  repoItemId: string
}

export async function atualizarGrafoDeVinculos(deps: AtualizarGrafoDeps): Promise<void> {
  const client = new ProjectV2Client({ token: deps.githubToken })
  const input = { owner: deps.owner, repo: deps.repo, number: deps.numero, type: deps.tipo }

  const [hierarquia, milestone, projectFields, labelsAndAssignees, prsLigados] = await Promise.all([
    deps.tipo === 'issue'
      ? client.getIssueHierarchy(input)
      : Promise.resolve({ parents: [], subIssues: [] }),
    client.getItemMilestone(input),
    client.getProjectsV2Fields(input),
    client.getItemLabelsAndAssignees(input),
    client.getPullRequestCrossReferences(input),
  ])

  await deps.prisma.repoItemVinculos.upsert({
    where: { repoItemId: deps.repoItemId },
    create: {
      repoItemId: deps.repoItemId,
      hierarquia: hierarquia as never,
      milestone: milestone as never,
      projectFields: projectFields as never,
      labelsAndAssignees: labelsAndAssignees as never,
      prsLigados: prsLigados as never,
    },
    update: {
      hierarquia: hierarquia as never,
      milestone: milestone as never,
      projectFields: projectFields as never,
      labelsAndAssignees: labelsAndAssignees as never,
      prsLigados: prsLigados as never,
    },
  })
}
