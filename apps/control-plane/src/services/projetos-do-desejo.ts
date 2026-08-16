import type { PrismaClient } from '@prisma/client'

// QUAL projeto aceita um pedido do dono. Uma regra só, num lugar só.
//
// O pedido entra por duas portas — a tela (POST /api/v1/desejos) e o mensageiro
// (o /desejo do bot). Enquanto cada porta escreveu o próprio filtro, elas
// divergiram: o bot exigia projeto ATIVO e a rota HTTP não. O mesmo dono, com o
// mesmo projeto desativado, era atendido por uma porta e informado pela outra de
// que "não tem projeto nenhum" — duas verdades sobre o mesmo fato.
//
// A regra que vale é a mais estrita, e ela não é gosto: o scheduler só trabalha
// projeto ativo (`plugins/scheduler.ts` filtra `project: { isActive: true }`).
// Aceitar pedido em projeto desativado criaria a issue e a deixaria parada para
// sempre — o dono leria "registrado" e nada aconteceria. Recusar na porta diz a
// verdade na hora.

type PrismaLike = Pick<PrismaClient, 'project'>

/** Projeto do dono, do ponto de vista de "para qual repositório vai o pedido". */
export interface ProjetoDoDesejo {
  id: string
  nome: string
  /** Endereço do repositório ("dono/repo"). É o identificador que o dono digita. */
  repo: string
}

/**
 * O filtro ÚNICO de quem pode receber um pedido. Exportado para que uma terceira
 * porta (se houver) reuse em vez de reescrever — foi a reescrita que criou a
 * divergência.
 */
export const ACEITA_PEDIDO = { isActive: true } as const

/**
 * Os projetos do dono que aceitam pedido. `wingId` é o endereço do REPOSITÓRIO
 * ("dono/repo"), não a chave do tenant — por isso é ele que vira o repo.
 */
export async function projetosParaDesejo(
  prisma: PrismaLike,
  userId: string
): Promise<ProjetoDoDesejo[]> {
  const projetos = await prisma.project.findMany({
    where: { userId, ...ACEITA_PEDIDO },
    select: { id: true, name: true, wingId: true },
    orderBy: { createdAt: 'asc' },
  })
  return projetos.map((p) => ({ id: p.id, nome: p.name, repo: p.wingId }))
}

/**
 * UM projeto do dono, pelo id, se ele aceitar pedido. `null` cobre os três casos
 * que a porta trata igual — não existe, não é dele, ou está desativado —, e é de
 * propósito: dizer qual dos três seria contar a quem tenta adivinhar se o id
 * pertence a outra conta.
 */
export async function projetoParaDesejo(
  prisma: PrismaLike,
  args: { projectId: string; userId: string }
): Promise<{ id: string; githubRepo: string } | null> {
  const projeto = await prisma.project.findFirst({
    where: { id: args.projectId, userId: args.userId, ...ACEITA_PEDIDO },
    select: { id: true, wingId: true },
  })
  return projeto ? { id: projeto.id, githubRepo: projeto.wingId } : null
}
