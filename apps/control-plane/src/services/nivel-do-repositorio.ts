import { NIVEIS_DE_AUTONOMIA, normalizarNivel } from '@gitorch/cadence'

/**
 * O nível de autonomia de um repositório, lido SEMPRE entre os projetos ATIVOS.
 *
 * `wingId` só é único por dono: dois projetos (de donos diferentes, ou do mesmo
 * dono) podem apontar para o mesmo repositório, cada um com a sua autonomia, e
 * um projeto desativado ainda guarda a dele. Buscar "o primeiro projeto com este
 * repositório" faz um herdar o nível do outro.
 *
 *   projeto conhecido e ativo → o nível DELE
 *   projeto desconhecido      → o nível MAIS RESTRITO entre os ativos do
 *                               repositório (nunca mais largo que o de algum)
 *   nenhum projeto ativo      → `null` (a porta recusa)
 *   algum nível ausente       → `null` (o lado seguro)
 */
export interface PrismaDeNivel {
  project: {
    findMany: (args: {
      where: { wingId: string; isActive: true }
      select: { id: true; autonomia: true }
    }) => Promise<Array<{ id: string; autonomia: string | null }>>
  }
}

export async function nivelDoRepositorio(
  prisma: PrismaDeNivel,
  repo: string,
  projectId?: string
): Promise<string | null> {
  const linhas = await prisma.project.findMany({
    where: { wingId: repo, isActive: true },
    select: { id: true, autonomia: true },
  })
  if (linhas.length === 0) return null

  const doProjeto = projectId ? linhas.find((l) => l.id === projectId) : undefined
  if (doProjeto) return doProjeto.autonomia ?? null

  let maisRestrito: string | null = null
  let posicaoMaisRestrita = Number.POSITIVE_INFINITY
  for (const linha of linhas) {
    if (linha.autonomia === null) return null
    const nivel = normalizarNivel(linha.autonomia)
    const posicao = NIVEIS_DE_AUTONOMIA.indexOf(nivel)
    if (posicao < posicaoMaisRestrita) {
      posicaoMaisRestrita = posicao
      maisRestrito = nivel
    }
  }
  return maisRestrito
}
