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
  /**
   * L5-T3: só quando a ação é 'aguardar' por causa de sinal de vida achado no
   * teto de cutucadas. Os nudges anteriores contaram contra uma sessão que na
   * verdade seguia trabalhando — zerar evita que a PRÓXIMA passagem parada
   * chegue com `nudges` já no teto e caia direto no abandono sem dar mais
   * nenhuma chance de insistir de verdade.
   */
  zerarNudges?: boolean
  /**
   * L5-T3: só quando a ação é 'abandonar'. O tempo real de silêncio (medido
   * pelo mesmo `paradoHaMs` que decidiu o abandono) para quem lê o aviso
   * entender a régua usada — não só "abandonei", mas "abandonei depois de
   * quanto tempo calado".
   */
  motivoDoAbandono?: string
}

/**
 * Tempo sem avanço a partir do qual uma sessão "trabalhando" passa a ser
 * tratada como parada.
 *
 * A API não tem estado para "empacado": uma sessão pode ficar em progresso
 * indefinidamente sem produzir nada.
 *
 * Até esta correção (L5-T3) eram noventa minutos — calibrados contra o tique
 * do relógio, não contra o dev assíncrono de verdade. Medido no banco de
 * produção: a mediana de vida de uma sessão é 12,6 HORAS e o p90 é 74,5
 * horas. Com noventa minutos e três nudges (MAX_NUDGES), a primeira cutucada
 * chegava antes de a sessão ter tido tempo de respirar, e o teto de abandono
 * era alcançado em poucas horas — 48 das 86 sessões abandonadas na história
 * do produto morreram assim, ainda `IN_PROGRESS`, média de 3,4 nudges e só 10
 * com pull request.
 *
 * Três cutucadas cobrindo a MEDIANA inteira: 12,6h ÷ 3 ≈ 4,2h por intervalo,
 * arredondado para 4h — folgado o bastante para não interromper quem está no
 * meio de um passo real, curto o bastante para uma sessão de verdade travada
 * não girar por dias. E não é mais o único freio contra abandono indevido:
 * antes de desistir, a decisão agora checa um sinal de vida independente
 * (`houveAtividadeDesdeUltimoNudge`) — mesmo cutucando "cedo demais", uma
 * sessão que seguir mostrando atividade nunca é abandonada por isto, só
 * reexaminada com o contador zerado.
 */
export const PARADO_MS = 4 * 60 * 60 * 1000

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
  /**
   * L5-T3 — sinal de vida independente de `paradoHaMs`. `paradoHaMs` vem de
   * `session.updateTime`, e esse carimbo de topo nem sempre acompanha
   * trabalho real: a página de atividades do Jules (`progressUpdated`,
   * `artifacts`, `agentMessaged`, `sessionCompleted`) pode mostrar produção
   * nova que o `updateTime` da sessão não refletiu. Diz se HOUVE alguma
   * atividade dessas depois do último nudge. Só importa no instante de
   * decidir abandonar; opcional porque um chamador que não mede preserva o
   * comportamento anterior (contagem cega de nudges).
   */
  houveAtividadeDesdeUltimoNudge?: boolean
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
    if (args.nudges >= MAX_NUDGES) {
      // SINAL DE VIDA (L5-T3) antes de desistir: a contagem cega de nudges
      // ignorava que a sessão podia estar trabalhando o tempo todo —
      // `paradoHaMs` vem de `session.updateTime`, e esse carimbo nem sempre
      // acompanha atividade real. Medido em produção: 48 das 86 sessões
      // abandonadas na história do produto morreram assim, ainda
      // `IN_PROGRESS`, média de 3,4 nudges e só 10 com PR — 20% de toda a
      // história do produto jogada fora sem falha nenhuma do dev.
      if (args.houveAtividadeDesdeUltimoNudge) {
        // Há atividade nova: ela está viva. Zera o contador e volta a
        // esperar — a próxima sequência de cutucadas começa do zero, em vez
        // de já nascer no teto e cair direto no abandono na próxima
        // passagem parada.
        return { acao: 'aguardar', zerarNudges: true }
      }
      // Sem sinal de vida nenhum: abandona como antes, mas o motivo carrega
      // o tempo real de silêncio — não só "abandonei", mas "abandonei
      // depois de quanto tempo calado".
      const horas = (args.paradoHaMs / (60 * 60 * 1000)).toFixed(1)
      return {
        acao: 'abandonar',
        motivoDoAbandono: `${horas}h de silêncio real, sem atividade após ${args.nudges} cutucada(s)`,
      }
    }
    // Sem método de retomada na API, o único jeito de destravar é pedir para
    // continuar. Com teto: senão a sessão gira para sempre queimando cota do
    // motor do cliente sem nunca entregar.
    return { acao: 'insistir' }
  }

  return { acao: 'aguardar' }
}
