import type { PrismaClient } from '@prisma/client'
import { ProjectV2Client } from '@gitorch/github-sync'

import { Prisma } from '@prisma/client'

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
      hierarquia: hierarquia as Prisma.InputJsonValue,
      milestone: milestone as Prisma.InputJsonValue,
      projectFields: projectFields as Prisma.InputJsonValue,
      labelsAndAssignees: labelsAndAssignees as Prisma.InputJsonValue,
      prsLigados: prsLigados as Prisma.InputJsonValue,
    },
    update: {
      hierarquia: hierarquia as Prisma.InputJsonValue,
      milestone: milestone as Prisma.InputJsonValue,
      projectFields: projectFields as Prisma.InputJsonValue,
      labelsAndAssignees: labelsAndAssignees as Prisma.InputJsonValue,
      prsLigados: prsLigados as Prisma.InputJsonValue,
    },
  })
}
