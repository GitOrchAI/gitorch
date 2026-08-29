// Decide o que fazer com uma sessão de trabalho do dev assíncrono, olhando só
// o estado — sem tocar rede, sem tocar banco.
//
// Antes disto a delegação criava a sessão e ia embora. Visto em produção: o dev
// leu os registros da execução que falhou, leu os commits recentes, abriu o
// arquivo do fluxo e terminou com uma pergunta técnica precisa — e ficou parado
// esperando alguém responder. Criar sessão sem acompanhar é falar sem ouvir.
//
// O que a API permite, verificado: NÃO existe evento nem aviso (só consulta), e
// NÃO existe método de retomada — nem `resume`, nem `continue`, nem `pause`.
// Destravar uma sessão parada só é possível mandando mensagem pedindo para
// continuar. Todo o desenho abaixo sai dessa restrição.
//
// A lei do produto vale aqui: a LLM não age no serviço externo. Ela redige a
// resposta; quem envia é o executor.

export interface ContextoDaTask {
  issueNumber: number
  tituloDaIssue: string
  corpoDaIssue: string
}

export interface DecisaoDaSessao {
  acao:
    | 'aguardar'
    | 'responder'
    | 'aprovar-plano'
    | 'julgar'
    | 'investigar'
    | 'insistir'
    | 'abandonar'
    // O Jules terminou (COMPLETED sem PR, ou FAILED/CANCELLED) e não vai andar
    // sozinho: a vigia FECHA a linha e a issue volta para a fila (D51 — nunca
    // abandona de vez). O motivo exato e a situação do PR ficam com o ciclo
    // terminal (sessao-terminal.ts), acionado pela vigia via injeção.
    | 'fechar-terminal'
  /** Só quando a ação é responder: o que o motor precisa saber para redigir. */
  contextoParaOMotor?: string
}

/**
 * Tempo sem avanço a partir do qual uma sessão "trabalhando" passa a ser
 * tratada como parada.
 *
 * A API não tem estado para "empacado": uma sessão pode ficar em progresso
 * indefinidamente sem produzir nada. Noventa minutos é folgado o bastante para
 * não interromper trabalho real e curto o bastante para a tarefa não dormir um
 * dia inteiro.
 */
export const PARADO_MS = 90 * 60 * 1000

/** Quantas vezes pedimos para continuar antes de desistir da sessão. */
export const MAX_NUDGES = 3

/**
 * Olha o estado e diz de quem é a bola.
 *
 * Estado desconhecido resolve em "aguardar" de propósito: o serviço pode
 * introduzir estados novos, e agir às cegas sobre um estado que não entendemos
 * é pior do que esperar o próximo ciclo.
 */
export function decidirRespostaDaSessao(args: {
  estado: string
  ultimaMensagem: string
  contextoDaTask: ContextoDaTask
  /** A sessão já entregou um PR? É o que separa concluir de entregar. */
  temPr: boolean
  /** Há quanto tempo a sessão não dá sinal de avanço. */
  paradoHaMs: number
  /** Quantas vezes já pedimos para continuar nesta sessão. */
  nudges: number
}): DecisaoDaSessao {
  const estado = args.estado.toUpperCase()

  if (estado === 'COMPLETED') {
    // COM PR → julgar (o QA cuida). SEM PR → concluiu sem entregar nada: o
    // trabalho morreu dentro da sessão e ela NÃO vai andar sozinha. Até 29/08
    // isto ia para 'investigar', que acionava o SM em loop e NUNCA fechava a
    // linha — a vaga ficava presa para sempre (medido: 21 de 23 sessões assim).
    // Agora fecha e a issue volta para a fila (D51).
    return args.temPr ? { acao: 'julgar' } : { acao: 'fechar-terminal' }
  }

  if (estado === 'FAILED' || estado === 'CANCELLED') {
    // Mesma coisa: falhou e não retoma por mensagem (verificado — COMPLETED/
    // FAILED não aceitam :sendMessage de retomada). Fecha e redelega.
    return { acao: 'fechar-terminal' }
  }

  if (estado === 'AWAITING_PLAN_APPROVAL') {
    // Aprovar plano não exige julgamento novo: o contrato do trabalho já está
    // na issue, e foi ele que autorizou a delegação. Gastar o motor aqui seria
    // pagar duas vezes pela mesma decisão.
    return { acao: 'aprovar-plano' }
  }

  if (estado === 'AWAITING_USER_FEEDBACK') {
    const contexto = [
      `The async developer is working on issue #${args.contextoDaTask.issueNumber} ` +
        `("${args.contextoDaTask.tituloDaIssue}") and asked a question.`,
      '',
      'Question from the developer:',
      args.ultimaMensagem,
      '',
      'The task contract (this is what the work must satisfy):',
      args.contextoDaTask.corpoDaIssue,
      '',
      'Answer the question directly and technically, grounded in the contract above.',
      'If the answer changes what "done" means, restate the Verification Criteria.',
      'If the question is a product decision that the contract does not cover, say so',
      'explicitly instead of guessing.',
    ].join('\n')

    return { acao: 'responder', contextoParaOMotor: contexto }
  }

  const trabalhando = estado === 'IN_PROGRESS' || estado === 'QUEUED' || estado === 'PLANNING'
  const parada = estado === 'PAUSED' || (trabalhando && args.paradoHaMs >= PARADO_MS)

  if (parada) {
    // Sem método de retomada na API, o único jeito de destravar é pedir para
    // continuar. Com teto: senão a sessão gira para sempre queimando cota do
    // motor do cliente sem nunca entregar.
    return args.nudges >= MAX_NUDGES ? { acao: 'abandonar' } : { acao: 'insistir' }
  }

  return { acao: 'aguardar' }
}
