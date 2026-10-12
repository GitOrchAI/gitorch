// De onde vem a evidência de que uma tarefa já foi entregue (suspeita de tarefa
// já resolvida): o banco do PROJETO dela e o GitHub do repositório dela.
//
// Tudo aqui é filtrado por projeto e por tarefa: o número da issue e o do PR só
// são únicos dentro de um repositório, e a sessão de outro projeto com o mesmo
// número não pode provar a entrega desta.

import type { DepsDaEvidencia, EntregaMesclada } from './suspeita-de-tarefa-resolvida.js'

/** Só o que a evidência precisa do banco. */
export interface PrismaDaEvidencia {
  devSession: {
    findMany: (args: {
      where: {
        projectId: string
        issueNumber: number
        OR: Array<{ mergeCommitSha: { not: null } } | { closedReason: 'merged' }>
      }
      select: { pullRequestNumber: true; closedAt: true; updatedAt: true }
    }) => Promise<
      Array<{ pullRequestNumber: number | null; closedAt: Date | null; updatedAt: Date }>
    >
    count: (args: {
      where: { projectId: string; issueNumber: number; closedAt: null }
    }) => Promise<number>
  }
  repoItem: {
    findUnique: (args: {
      where: { projectId_tipo_numero: { projectId: string; tipo: 'issue'; numero: number } }
      select: { vinculos: { select: { prsLigados: true } } }
    }) => Promise<{ vinculos: { prsLigados: unknown } | null } | null>
  }
}

export function criarDepsDaEvidencia(args: {
  prisma: PrismaDaEvidencia
  projectId: string
  repositorio: string
  issueNumber: number
  /** GET na API do GitHub (caminho a partir da raiz); lança erro com `status`. */
  lerGitHub: (caminho: string) => Promise<unknown>
}): DepsDaEvidencia {
  const { prisma, projectId, repositorio, issueNumber, lerGitHub } = args
  return {
    sessoesMescladas: async () =>
      (
        await prisma.devSession.findMany({
          where: {
            projectId,
            issueNumber,
            OR: [{ mergeCommitSha: { not: null } }, { closedReason: 'merged' }],
          },
          select: { pullRequestNumber: true, closedAt: true, updatedAt: true },
        })
      ).map((r) => ({ pullRequest: r.pullRequestNumber, mergedAt: r.closedAt ?? r.updatedAt })),
    prsLigadosNaFicha: async () => {
      const ficha = await prisma.repoItem.findUnique({
        where: { projectId_tipo_numero: { projectId, tipo: 'issue', numero: issueNumber } },
        select: { vinculos: { select: { prsLigados: true } } },
      })
      const ligados = ficha?.vinculos?.prsLigados as { closedByPullRequests?: unknown } | null
      return Array.isArray(ligados?.closedByPullRequests)
        ? ligados.closedByPullRequests.filter((n): n is number => typeof n === 'number')
        : []
    },
    lerPullRequest: async (numero) => {
      try {
        const pr = (await lerGitHub(`/repos/${repositorio}/pulls/${numero}`)) as {
          merged?: boolean
          merged_at?: string | null
          base?: { ref?: string; repo?: { default_branch?: string } }
        }
        return {
          mesclado: pr.merged === true,
          mergedAt: pr.merged_at ?? null,
          baseEhPadrao: !!pr.base?.ref && pr.base.ref === pr.base.repo?.default_branch,
        }
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null
        throw err
      }
    },
    lerEventosDaIssue: async () =>
      (await lerGitHub(
        `/repos/${repositorio}/issues/${issueNumber}/events?per_page=100`
      )) as Array<{
        event?: string
        created_at?: string
      }>,
    existeTrabalhoEmAndamento: async () =>
      (await prisma.devSession.count({ where: { projectId, issueNumber, closedAt: null } })) > 0,
  }
}

// ------------------------------------------------------------------ citação

/**
 * O texto cita ESTA tarefa deste repositório? Aceita `#N`, `issue N`, `issues N`
 * e `issues/N`, com ou sem o endereço do próprio repositório. Citação de outro
 * repositório (`outro/repo#N`, endereço de outro repositório) e número que só
 * começa igual (`#8740`) não contam.
 */
export function textoCitaATarefa(texto: string, repositorio: string, numero: number): boolean {
  const repo = repositorio.toLowerCase()
  let achou = false
  const marca = (r: string, n: string): void => {
    if (r.toLowerCase() === repo && Number(n) === numero) achou = true
  }
  const restante = texto
    .replace(/\bhttps?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi, (_m, r, n) => {
      marca(r, n)
      return ' '
    })
    .replace(/\bhttps?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi, ' ')
    .replace(/(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)/g, (_m, r, n) => {
      marca(r, n)
      return ' '
    })
  if (achou) return true
  const n = String(numero)
  return new RegExp(
    `(?<![\\w/.-])#${n}(?!\\d)|\\bissues?\\s+#?${n}(?!\\d)|(?<![\\w/])issues/${n}(?!\\d)`,
    'i'
  ).test(restante)
}

/**
 * PRs mesclados na branch padrão, DEPOIS de a tarefa nascer, que citam a tarefa
 * no título ou no corpo. Uma única chamada de busca. Lança em falha.
 */
export async function buscarPrsQueCitamATarefa(args: {
  lerGitHub: (caminho: string) => Promise<unknown>
  repositorio: string
  numero: number
  criadaEm: Date
  ramoPadrao: () => Promise<string>
}): Promise<EntregaMesclada[]> {
  const ramo = await args.ramoPadrao()
  const dia = args.criadaEm.toISOString().slice(0, 10)
  const consulta = `repo:${args.repositorio} is:pr is:merged base:${ramo} merged:>=${dia} ${args.numero} in:title,body`
  const resposta = (await args.lerGitHub(
    `/search/issues?q=${encodeURIComponent(consulta)}&per_page=30`
  )) as {
    items?: Array<{
      number?: number
      title?: string | null
      body?: string | null
      repository_url?: string
      pull_request?: { merged_at?: string | null }
    }>
  }
  const doRepositorio = `/repos/${args.repositorio}`.toLowerCase()
  const achadas: EntregaMesclada[] = []
  for (const item of resposta.items ?? []) {
    if (typeof item.number !== 'number' || item.number === args.numero) continue
    if (item.repository_url && !item.repository_url.toLowerCase().endsWith(doRepositorio)) continue
    const mergedAt = item.pull_request?.merged_at
    if (!mergedAt) continue
    const quando = new Date(mergedAt)
    if (!(quando.getTime() > args.criadaEm.getTime())) continue
    if (!textoCitaATarefa(`${item.title ?? ''}\n${item.body ?? ''}`, args.repositorio, args.numero))
      continue
    achadas.push({ pullRequest: item.number, mergedAt: quando })
  }
  return achadas
}
