import type { EntregaJulgada } from './reprovacao-que-ensina.js'

/**
 * O histórico de julgamentos de um repositório, guardado como `Event` do
 * projeto — a mesma prateleira durável que o resto do produto usa para
 * marcadores que precisam sobreviver a reinício.
 *
 * Durável porque a conta é sobre DIAS: o patinhas acumulou dez reprovações
 * seguidas em quatro dias, e nesse intervalo o serviço reiniciou dezenas de
 * vezes. Em memória, a conta nunca passaria de um.
 */

/**
 * Só o que estas funções usam do Prisma — permite injetar um fake nos testes.
 *
 * Não há `project` aqui de propósito. A primeira versão procurava o projeto por
 * `wingId` (o endereço do repositório) e a revisão pegou: `wingId` NÃO é único
 * global — o schema tem `@@unique([userId, wingId])` justamente porque dois
 * clientes podem cadastrar o mesmo repositório. `findFirst` por endereço podia
 * devolver o projeto do OUTRO dono, e a reprovação de um seria contada na conta
 * do outro. O projeto vem pronto de quem chama, que já sabe de quem é.
 */
export interface PrismaDoHistorico {
  event: {
    create: (args: unknown) => Promise<unknown>
    findMany: (args: unknown) => Promise<Array<{ payload: unknown; createdAt: Date }>>
  }
}

export const TIPO_DO_EVENTO = 'qa_judgment'

/**
 * Quantos julgamentos olhar para trás.
 *
 * Maior que o teto de escalada de propósito: a conta precisa enxergar a
 * reprovação de código que ZERA a sequência, e ela pode estar logo antes das
 * barradas. Uma janela apertada esconderia o caminho de volta.
 */
export const JANELA_DE_JULGAMENTOS = 20

export async function registrarJulgamento(deps: {
  prisma: PrismaDoHistorico
  projectId: string
  peloPortao: boolean
}): Promise<void> {
  await deps.prisma.event.create({
    data: {
      projectId: deps.projectId,
      type: TIPO_DO_EVENTO,
      payload: { peloPortao: deps.peloPortao },
    },
  })
}

export async function lerHistoricoDoProjeto(deps: {
  prisma: PrismaDoHistorico
  projectId: string
}): Promise<EntregaJulgada[]> {
  const eventos = await deps.prisma.event.findMany({
    where: { projectId: deps.projectId, type: TIPO_DO_EVENTO },
    orderBy: { createdAt: 'desc' },
    take: JANELA_DE_JULGAMENTOS,
  })

  return eventos.map((e) => ({
    // Payload sem a marca é julgamento antigo, de antes deste registro
    // existir. Tratar como "pelo portão" inventaria uma sequência que ninguém
    // mediu — e a escalada existe justamente para não inventar.
    peloPortao: lerPeloPortao(e.payload),
    quando: e.createdAt,
  }))
}

function lerPeloPortao(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false
  const valor = (payload as { peloPortao?: unknown }).peloPortao
  return valor === true
}
