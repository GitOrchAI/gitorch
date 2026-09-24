import { ProjectV2Client } from '@gitorch/github-sync'
import { acharTarefaDoItem, VinculoDaTarefa } from './vinculo-da-tarefa.js'
import { lerFichaDoItem, atualizarFichaDoItem } from './ficha-do-item.js'

export async function descobrirVinculoDoRetrato(deps: {
  numeroDoPr: number
  repository: string
  sinaisPr: { autor: string | null; corpo: string | null; headRefName?: string }
  sessoesFechadas: unknown[]
  projectV2Client: Pick<ProjectV2Client, 'closingIssuesDoPr'>
  ghGet: (caminho: string) => Promise<unknown>
  issueCache: Map<number, boolean>
}): Promise<VinculoDaTarefa | null> {
  const fetchClosingIssues = async (): Promise<number[]> => {
    const [owner, repo] = deps.repository.split('/')
    return deps.projectV2Client.closingIssuesDoPr({
      owner: owner as string,
      repo: repo as string,
      prNumber: deps.numeroDoPr,
    })
  }

  const ligacoes = (deps.sinaisPr.corpo ?? '').matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)/gi)
  for (const ligacao of ligacoes) {
    const mentionedIssueNum = Number(ligacao[1])
    if (!deps.issueCache.has(mentionedIssueNum)) {
      try {
        const issueData = (await deps.ghGet(
          `/repos/${deps.repository}/issues/${mentionedIssueNum}`
        )) as { labels?: Array<string | { name?: string }> | null }
        const hasTaskLabel =
          issueData.labels?.some((l) => (typeof l === 'string' ? l : l.name) === 'gitorch:task') ??
          false
        deps.issueCache.set(mentionedIssueNum, hasTaskLabel)
      } catch (e) {
        deps.issueCache.set(mentionedIssueNum, false)
      }
    }
  }

  return acharTarefaDoItem({
    numeroDoPr: deps.numeroDoPr,
    autor: deps.sinaisPr.autor ?? undefined,
    corpo: deps.sinaisPr.corpo ?? undefined,
    headRefName: deps.sinaisPr.headRefName,
    sessoes: deps.sessoesFechadas as never,
    closingIssues: fetchClosingIssues,
    issueComEtiquetaDeDelegacao: (num) => deps.issueCache.get(num) ?? false,
  })
}

export async function mesclarEAtualizarFicha(deps: {
  prisma: never
  projectId: string
  numero: number
  origemClassificada: string
}): Promise<void> {
  const fichaExistente = await lerFichaDoItem({
    prisma: deps.prisma,
    projectId: deps.projectId,
    tipo: 'pr',
    numero: deps.numero,
  })

  await atualizarFichaDoItem({
    prisma: deps.prisma,
    projectId: deps.projectId,
    tipo: 'pr',
    numero: deps.numero,
    estado: { ...(fichaExistente?.estado as unknown as Record<string, unknown>), status: 'open' },
    origem: deps.origemClassificada,
  })
}
