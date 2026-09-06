import { lerMarca } from './pergunta-sem-resposta.js'

/**
 * O mínimo do Prisma que esta reconciliação usa — SÓ `devSession.findMany`.
 * GARANTIA ESTRUTURAL pós-D75 (05/09, decisão do dono): este tipo não tem
 * NENHUM campo `agentQuestion` — não existe jeito de este módulo criar uma
 * `agent_question`, nem por engano, nem numa reescrita futura descuidada.
 */
export interface PrismaParaReconciliacao {
  devSession: {
    findMany: (
      args: unknown
    ) => Promise<Array<{ sessionName: string; issueNumber: number; answeredHash: string | null }>>
  }
}

export interface DepsDeReconciliacao {
  prisma: PrismaParaReconciliacao
  /**
   * Encerra a sessão presa — SEMPRE com o motivo redelegante
   * `pergunta-sem-resposta` (o MESMO que `session-watch.ts` já usa quando
   * "a resposta não destravou"; `MOTIVOS_QUE_REDELEGAM`,
   * dev-session-store.ts): a issue volta para a fila, nunca se perde. É a
   * ÚNICA ação que este módulo pode pedir — não existe `ask`/`criar
   * pergunta` na sua superfície, por desenho.
   */
  fecharSessao: (args: { sessionName: string; agora: Date }) => Promise<void>
  onWarn?: (mensagem: string) => void
  /** Nunca engole: rede/Prisma falhando ao fechar uma sessão presa é nível `error`, não `warn`. */
  onError?: (err: unknown, mensagem: string) => void
}

export interface ResumoDaReconciliacao {
  encontradas: number
  encerradas: number
  falhas: number
}

/**
 * L4-T30 — REESCRITA pós-D75 (05/09, decisão do dono, palavras dele: "os
 * agentes do gitorch não podem mandar essas dúvidas pra mim").
 *
 * ATÉ ESTA TASK, esta função migrava as sessões marcadas `respondida:` SEM
 * `agent_question` real (a assinatura exata do defeito de
 * `escalar-duvida-ao-dono.ts` medida em 02/09, L4-T3 — 24 sessões assim)
 * criando uma `agent_question` DE VERDADE via `agentQuestionService.ask` —
 * com contexto executivo VAZIO por desenho (D73/L4-T23, migração histórica
 * pontual). D75 fechou de vez o caminho VIVO da dúvida do dev até o dono
 * (`escalar-duvida-ao-dono.ts`), mas este caminho LEGADO continuava rodando
 * a cada tique, para todo projeto ativo, e foi ele que mandou as duas
 * perguntas vazias de 05/09 — nunca foi desligado depois do conserto do
 * caminho vivo.
 *
 * A ASSINATURA continua a MESMA (é como se acha a sessão): AWAITING_USER_
 * FEEDBACK, ainda aberta (`closedAt: null`), marcada `respondida:` (nunca
 * `escalada:`/`tentando:`/`desisti:` — `lerMarca` decide) — mas o DESTINO
 * mudou por completo: em vez de criar pergunta, ENCERRA a sessão direto
 * (`fecharSessao`, motivo `pergunta-sem-resposta`) — a mesma decisão que
 * `session-watch.ts` já toma para "a resposta não destravou em 24h", só que
 * aplicada de uma vez para o legado que nunca teve resposta real nenhuma
 * por trás. A issue volta para a fila (motivo redelegante) em vez de ficar
 * presa para sempre esperando um dono que, por D75, nunca vai responder.
 *
 * Idempotente por design: uma sessão fechada some do `findMany` (filtra
 * `closedAt: null`) — nenhuma passada reprocessa a mesma sessão duas vezes.
 * Nunca lança: uma sessão que falha ao fechar (rede, Prisma) conta como
 * falha e a próxima é tentada — a reconciliação de um projeto não pode cair
 * por causa de uma sessão só.
 */
export async function reconciliarDuvidasEscaladasDoProjeto(
  args: { projectId: string; repository: string },
  deps: DepsDeReconciliacao
): Promise<ResumoDaReconciliacao> {
  const candidatas = await deps.prisma.devSession.findMany({
    where: {
      projectId: args.projectId,
      state: 'AWAITING_USER_FEEDBACK',
      closedAt: null,
      answeredHash: { not: null },
    },
    select: { sessionName: true, issueNumber: true, answeredHash: true },
  })

  const resumo: ResumoDaReconciliacao = { encontradas: 0, encerradas: 0, falhas: 0 }
  const agora = new Date()

  for (const sessao of candidatas) {
    const marcaBruta = sessao.answeredHash ?? ''
    const lida = lerMarca(marcaBruta)
    // Só a ASSINATURA exata do defeito: `respondida:` sem pergunta real.
    // `escalada:` (já passou pelo caminho vivo do D75) / `tentando:` /
    // `desisti:` / formato desconhecido não são o padrão medido — ignora,
    // para não interferir no fluxo normal dessas sessões.
    if (!lida || lida.situacao !== 'respondida') continue

    resumo.encontradas += 1

    try {
      await deps.fecharSessao({ sessionName: sessao.sessionName, agora })
      resumo.encerradas += 1
    } catch (err) {
      resumo.falhas += 1
      const mensagem =
        `reconciliação: não deu para encerrar a sessão presa de ` +
        `${args.repository}#${sessao.issueNumber} (sessão ${sessao.sessionName}): ${String(err)}`
      deps.onError?.(err, mensagem)
      deps.onWarn?.(mensagem)
    }
  }

  return resumo
}
