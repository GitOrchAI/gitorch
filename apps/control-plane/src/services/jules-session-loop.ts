// Acompanha as sessões de trabalho abertas no dev assíncrono.
//
// Antes disto a delegação criava a sessão e ia embora. Visto em produção: o dev
// leu os logs da execução que falhou, leu os commits recentes, abriu o arquivo
// do workflow e terminou com uma pergunta técnica precisa — e ficou parado
// horas esperando alguém responder. Criar sessão sem acompanhar é falar sem
// ouvir: a esteira morre no último elo, com o trabalho quase pronto.
//
// A lei do produto vale aqui também: a LLM não age no serviço externo. Ela
// redige a resposta; quem envia é o executor.

export type EstadoDaSessao = string

export interface ContextoDaTask {
  issueNumber: number
  tituloDaIssue: string
  corpoDaIssue: string
}

export interface DecisaoDaSessao {
  acao: 'aguardar' | 'responder' | 'aprovar-plano' | 'encerrar'
  /** Só quando a ação é responder: o que o motor precisa saber para redigir. */
  contextoParaOMotor?: string
}

/**
 * Decide o que fazer com uma sessão, olhando só o estado — sem tocar rede.
 *
 * Estado desconhecido resolve em "aguardar" de propósito: o serviço pode
 * introduzir estados novos, e agir às cegas sobre um estado que não
 * entendemos é pior que esperar o próximo ciclo.
 */
export function decidirRespostaDaSessao(args: {
  estado: EstadoDaSessao
  ultimaMensagem: string
  contextoDaTask: ContextoDaTask
}): DecisaoDaSessao {
  const estado = args.estado.toUpperCase()

  if (estado === 'COMPLETED' || estado === 'FAILED' || estado === 'CANCELLED') {
    return { acao: 'encerrar' }
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

  return { acao: 'aguardar' }
}

export interface SessaoAcompanhada {
  sessionId: string
  issueNumber: number
  estado: EstadoDaSessao
  ultimaMensagem: string
}

export interface AcompanharDeps {
  sessoes: Array<{ sessionId: string; issueNumber: number }>
  lerSessao: (sessionId: string) => Promise<SessaoAcompanhada>
  lerIssue: (numero: number) => Promise<{ number: number; title: string; body: string }>
  responder: (sessionId: string, texto: string) => Promise<boolean>
  aprovarPlano: (sessionId: string) => Promise<boolean>
  /** O motor redige a resposta; nunca fala com o serviço externo. */
  pedirAoMotor: (contexto: string) => Promise<string>
  onWarn?: (message: string) => void
}

export interface AcompanharResultado {
  respondidas: number
  planosAprovados: number
  encerradas: number
}

/**
 * Passa por cada sessão aberta e faz o que ela está pedindo.
 *
 * Falha numa sessão nunca contamina as outras: o dev de uma task não pode
 * ficar esperando porque o serviço engasgou na task do vizinho.
 */
export async function acompanharSessoesDoDev(deps: AcompanharDeps): Promise<AcompanharResultado> {
  const warn = deps.onWarn ?? (() => undefined)
  const resultado: AcompanharResultado = { respondidas: 0, planosAprovados: 0, encerradas: 0 }

  for (const { sessionId, issueNumber } of deps.sessoes) {
    try {
      const sessao = await deps.lerSessao(sessionId)
      const issue = await deps.lerIssue(issueNumber)

      const decisao = decidirRespostaDaSessao({
        estado: sessao.estado,
        ultimaMensagem: sessao.ultimaMensagem,
        contextoDaTask: {
          issueNumber: issue.number,
          tituloDaIssue: issue.title,
          corpoDaIssue: issue.body,
        },
      })

      if (decisao.acao === 'encerrar') {
        resultado.encerradas += 1
        continue
      }

      if (decisao.acao === 'aprovar-plano') {
        await deps.aprovarPlano(sessionId)
        resultado.planosAprovados += 1
        continue
      }

      if (decisao.acao === 'responder' && decisao.contextoParaOMotor) {
        const texto = (await deps.pedirAoMotor(decisao.contextoParaOMotor)).trim()
        if (texto.length === 0) {
          warn(
            `[jules-loop] o motor não produziu resposta para a sessão da issue #${issueNumber}; ` +
              `a sessão segue parada até o próximo ciclo`
          )
          continue
        }
        await deps.responder(sessionId, texto)
        resultado.respondidas += 1
      }
    } catch (err) {
      warn(
        `[jules-loop] falha ao acompanhar a sessão da issue #${issueNumber}: ${(err as Error).message}`
      )
    }
  }

  return resultado
}
