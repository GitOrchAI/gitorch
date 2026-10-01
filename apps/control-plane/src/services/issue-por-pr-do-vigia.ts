// De onde o vigia do PR tira "a tarefa de origem" de cada pull request.
//
// A sessão do dev (`dev_sessions`) é a fonte primeira. PR sem sessão ligada
// (ex.: gitorch #583/#690, padrao-executores #64/#132) caía em "sem tarefa de
// origem registrada" e o vigia o deixava parado; a ficha do item
// (`repo_items`, issue #877) já guarda a origem certa e é o segundo lugar.

import type { Prisma } from '@prisma/client'
import { issueConfiavelDaFicha } from './origem-do-item.js'

/** O mínimo do banco que a montagem precisa. */
export interface BancoDoIssuePorPr {
  devSession: {
    findMany: (args: {
      where: Prisma.DevSessionWhereInput
      select: { pullRequestNumber: true; issueNumber: true; closedAt: true }
      orderBy: { id: 'desc' }
    }) => Promise<
      Array<{ pullRequestNumber: number | null; issueNumber: number; closedAt: Date | null }>
    >
  }
  repoItem: {
    findMany: (args: {
      where: Prisma.RepoItemWhereInput
      select: { numero: true; origem: true; issueNumber: true }
    }) => Promise<Array<{ numero: number; origem: string | null; issueNumber: number | null }>>
  }
}

export interface IssuePorPrDoProjeto {
  /** PRs que ainda têm linha viva do dev atrás (são da vigia de sessões). */
  prsComSessaoViva: Set<number>
  /** PR → issue de origem: a sessão manda; a ficha confiável completa. */
  issuePorPr: Map<number, number>
}

export async function carregarIssuePorPr(
  db: BancoDoIssuePorPr,
  projectId: string
): Promise<IssuePorPrDoProjeto> {
  // A viva diz de quem é o PR AGORA; as fechadas dizem qual tarefa o originou.
  const linhas = await db.devSession.findMany({
    where: { projectId, pullRequestNumber: { not: null } },
    select: { pullRequestNumber: true, issueNumber: true, closedAt: true },
    orderBy: { id: 'desc' },
  })
  const prsComSessaoViva = new Set<number>()
  const issuePorPr = new Map<number, number>()
  for (const l of linhas) {
    if (l.pullRequestNumber === null) continue
    if (l.closedAt === null) prsComSessaoViva.add(l.pullRequestNumber)
    if (!issuePorPr.has(l.pullRequestNumber)) issuePorPr.set(l.pullRequestNumber, l.issueNumber)
  }

  // UMA leitura por projeto (não uma por PR): as fichas de PR com issue gravada.
  const fichas = await db.repoItem.findMany({
    where: { projectId, tipo: 'pr', issueNumber: { not: null } },
    select: { numero: true, origem: true, issueNumber: true },
  })
  for (const ficha of fichas) {
    if (issuePorPr.has(ficha.numero)) continue
    const issue = issueConfiavelDaFicha(ficha)
    if (issue !== null) issuePorPr.set(ficha.numero, issue)
  }

  return { prsComSessaoViva, issuePorPr }
}
