import type { EntregaJulgada } from './reprovacao-que-ensina.js'
import { JANELA_LIMPA, type EstadoDaJanela } from './aviso-por-janela.js'

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

/**
 * ESTEIRA-T15: o dono já foi avisado desta SEQUÊNCIA de barradas?
 *
 * `decidirSobreOProjeto` recalcula `seguidas` (3, 4, 5...) a cada julgamento
 * — sem esta marca, cada valor novo virava um aviso novo no Telegram. Foi a
 * rajada real de 29/08: "3 entregas barradas... Parei de reencaminhar", "4
 * entregas barradas", "5" — quatro mensagens em cinco minutos.
 *
 * Mesmo mecanismo do T11 (`aviso-por-janela.ts`: "avisa o dono UMA vez por
 * janela") — aqui não há espera por minutos (o gatilho é o julgamento que
 * cruza o teto, não o relógio), então quem chama usa `minutosAteAlertar=0`.
 */
export const TIPO_DO_AVISO_DE_BARRADAS = 'aviso-entregas-barradas'

export async function lerJanelaDeBarradas(deps: {
  prisma: PrismaDoHistorico
  projectId: string
}): Promise<EstadoDaJanela> {
  const [ultimo] = await deps.prisma.event.findMany({
    where: { projectId: deps.projectId, type: TIPO_DO_AVISO_DE_BARRADAS },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  const payload = ultimo?.payload as { desde?: string | null; avisado?: unknown } | undefined
  if (!payload) return JANELA_LIMPA
  return {
    desde: payload.desde ? new Date(payload.desde) : null,
    avisado: payload.avisado === true,
  }
}

export async function registrarJanelaDeBarradas(deps: {
  prisma: PrismaDoHistorico
  projectId: string
  estado: EstadoDaJanela
}): Promise<void> {
  await deps.prisma.event.create({
    data: {
      projectId: deps.projectId,
      type: TIPO_DO_AVISO_DE_BARRADAS,
      payload: { desde: deps.estado.desde?.toISOString() ?? null, avisado: deps.estado.avisado },
    },
  })
}
