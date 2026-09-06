import { PREFIXO_DUVIDA_DEV } from './dedup-key-de-duvida.js'

/**
 * L4-T30 — a LIMPEZA que sobrou depois de D75 (05/09, decisão do dono):
 * "os agentes do gitorch não podem mandar essas dúvidas pra mim" fechou o
 * caminho VIVO (`escalar-duvida-ao-dono.ts`), mas não apaga as
 * `agent_question` que a reconciliação LEGADA (`reconciliar-duvidas-
 * escaladas.ts`, L4-T3, criada 02/09) já tinha criado antes da decisão —
 * com contexto executivo VAZIO por desenho (D73/L4-T23, um caminho de
 * migração histórica pontual, nunca o caminho vivo). Duas chegaram ao dono
 * hoje (05/09); ao menos uma segue genuinamente `open` esperando decisão
 * que, por D75, ele nunca vai dar.
 *
 * Este módulo varre — por projeto, no mesmo relógio que já reconcilia
 * (`scheduler.ts`, `reconciliarDuvidasEscaladasLegadas`) — toda
 * `agent_question` ainda `open` com dedupKey `duvida-dev:*` (a MESMA
 * assinatura que `reprocessarPerguntasSemOpcoesDoProjeto` já usa para achar
 * perguntas quebradas, PREFIXO_DUVIDA_DEV, dedup-key-de-duvida.ts) e a
 * encerra pelo MESMO mecanismo de "assumida" que o produto já usa
 * (`AgentQuestionService.marcarAssumida`) — NUNCA `answer()`: isto não é
 * uma decisão do dono, é o produto puxando de volta uma dívida sua, citando
 * D75 no texto para quem olhar o histórico da pergunta depois.
 *
 * Idempotente por design: uma vez `assumida`, a pergunta some do `findMany`
 * (filtra `status: 'open'`) — nenhuma passada reprocessa a mesma pergunta
 * duas vezes. Nunca lança: uma pergunta que falha (rede, Prisma) conta como
 * falha e a próxima é tentada — esta limpeza de um projeto não pode cair
 * por causa de uma pergunta só (MESMO padrão de
 * `reprocessarPerguntasSemOpcoesDoProjeto` e `reconciliarDuvidasEscaladasDoProjeto`).
 */

export interface PrismaParaEncerrarDuvidasLegadas {
  agentQuestion: {
    findMany: (args: {
      where: { projectId: string; status: 'open'; dedupKey: { startsWith: string } }
    }) => Promise<Array<{ id: string }>>
  }
}

export interface DepsDeEncerrarDuvidasLegadas {
  prisma: PrismaParaEncerrarDuvidasLegadas
  /** `AgentQuestionService.marcarAssumida`, já vinculado à instância real. */
  marcarAssumida: (args: {
    questionId: string
    projectId: string
    suposicao: string
  }) => Promise<unknown>
  onWarn: (mensagem: string) => void
}

export interface ResumoDoEncerramento {
  encontradas: number
  encerradas: number
  falhas: number
}

/** O texto honesto que encerra a pergunta legada — cita D75 para quem olhar depois. */
export const TEXTO_ENCERRAMENTO_DUVIDA_LEGADA =
  'D75 (05/09, decisão do dono): dúvida do dev assíncrono nunca mais vira pergunta ao dono. ' +
  'Esta pergunta foi criada por um caminho de migração legado (L4-T3, 02/09) que já foi ' +
  'desligado — encerrando sem esperar resposta do dono; o time (QA/RA/PO) segue responsável ' +
  'por resolver a dúvida original do dev.'

export async function encerrarDuvidasLegadasAbertasDoProjeto(
  args: { projectId: string },
  deps: DepsDeEncerrarDuvidasLegadas
): Promise<ResumoDoEncerramento> {
  const abertas = await deps.prisma.agentQuestion.findMany({
    where: {
      projectId: args.projectId,
      status: 'open',
      dedupKey: { startsWith: PREFIXO_DUVIDA_DEV },
    },
  })

  const resumo: ResumoDoEncerramento = { encontradas: abertas.length, encerradas: 0, falhas: 0 }

  for (const pergunta of abertas) {
    try {
      await deps.marcarAssumida({
        questionId: pergunta.id,
        projectId: args.projectId,
        suposicao: TEXTO_ENCERRAMENTO_DUVIDA_LEGADA,
      })
      resumo.encerradas += 1
    } catch (err) {
      resumo.falhas += 1
      deps.onWarn(
        `encerrarDuvidasLegadasAbertas: não deu para encerrar a pergunta ${pergunta.id} ` +
          `(projeto ${args.projectId}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return resumo
}
