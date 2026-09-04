import type { AgentQuestionService } from './agent-question.js'
import type { PrismaDevSession } from './dev-session-store.js'
import { registrarEscalada } from './dev-session-store.js'
import { lerMarca } from './pergunta-sem-resposta.js'
import { perguntaExecutivaDeReserva } from './texto-de-escalada.js'
import { contextoExecutivoVazio } from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { PrismaParaChaveDoDev } from './chave-do-dev-assincrono.js'
import type { ultimaMensagemDoDevJules as ultimaMensagemDoDevJulesReal } from './jules-client.js'
import { dedupKeyDeDuvidaDoDev } from './dedup-key-de-duvida.js'

export interface PrismaParaReconciliacao extends PrismaDevSession, PrismaParaChaveDoDev {
  devSession: {
    findMany: (
      args: unknown
    ) => Promise<Array<{ sessionName: string; issueNumber: number; answeredHash: string | null }>>
  } & PrismaDevSession['devSession'] &
    PrismaParaChaveDoDev['devSession']
  agentQuestion: {
    findFirst: (args: {
      where: { projectId: string; dedupKey: string }
    }) => Promise<{ id: string } | null>
  }
}

export interface DepsDeReconciliacao {
  prisma: PrismaParaReconciliacao
  agentQuestionService?: Pick<AgentQuestionService, 'ask'> | undefined
  decifrar: (envelope: string) => string
  julesApiKeyDaInstancia: string | undefined
  ultimaMensagemDoDevJules?: typeof ultimaMensagemDoDevJulesReal
  onWarn?: (mensagem: string) => void
  /** C3 (fix-up L4-T3): a falha do `ask()` (rede, Prisma) já contava como
   *  falha e já mantinha a marca inalterada — mas só ia para `onWarn`, que
   *  se perde em qualquer monitoramento real. Produção passa `app.log.error`
   *  — sem isto a MESMA sessão presa é reprocessada a cada 6h em silêncio. */
  onError?: (err: unknown, mensagem: string) => void
}

export interface ResumoDaReconciliacao {
  presas: number
  criadas: number
  falhas: number
}

/**
 * O CONSERTO DAS 24 PRESAS (L4-T3, item 4) — medido em 02/09: 30
 * dev_sessions em AWAITING_USER_FEEDBACK, 24 marcadas `respondida:0:<hash>`
 * no instante da escalada (o defeito de `escalar-duvida-ao-dono.ts`, item 0)
 * e ZERO `agent_question` com dedupKey `duvida-dev:*`. O conserto do item 0
 * fecha a torneira para escaladas NOVAS; isto aqui migra as que já
 * aconteceram — sem uma reconciliação, ficariam presas para sempre (a marca
 * `respondida:` nunca mais é revisitada por `decidirSobreAPergunta`).
 *
 * A ASSINATURA EXATA do defeito, e só ela: sessão AINDA em
 * AWAITING_USER_FEEDBACK (o Jules não andou) E marcada `respondida:`
 * (`lerMarca` reconhece o formato) E SEM a `agent_question` correspondente
 * (`dedupKey` calculado do hash guardado na marca). Uma sessão que recebeu
 * resposta de VERDADE (`responder-o-dev`) normalmente sai de
 * AWAITING_USER_FEEDBACK no próximo estado do Jules — se ainda está lá com
 * essa marca, é o mesmo sinal que o dono usou para medir as 24.
 *
 * Idempotente por design: `agentQuestion.findFirst` evita perguntar de novo
 * se a `agent_question` já existe (outra reconciliação, ou um boot anterior
 * que criou a pergunta mas caiu antes de migrar a marca) — só corrige a
 * marca nesse caso. Nunca lança: uma sessão que falha (rede, Prisma) conta
 * como falha e a próxima é tentada — a reconciliação de um projeto não pode
 * cair por causa de uma sessão só.
 */
export async function reconciliarDuvidasEscaladasDoProjeto(
  args: { projectId: string; repository: string; userId: string | null },
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

  const resumo: ResumoDaReconciliacao = { presas: 0, criadas: 0, falhas: 0 }

  for (const sessao of candidatas) {
    const marcaBruta = sessao.answeredHash ?? ''
    // Já migrada (por esta reconciliação, num boot anterior) — nunca reprocessa.
    if (marcaBruta.startsWith('escalada:')) continue

    const lida = lerMarca(marcaBruta)
    // Só a ASSINATURA exata do defeito: `respondida:` sem pergunta real.
    // `tentando:`/`desisti:`/formato desconhecido não são o padrão medido —
    // ignora, para não interferir no fluxo normal dessas sessões.
    if (!lida || lida.situacao !== 'respondida') continue

    resumo.presas += 1
    const hash = lida.hash

    const perguntador = deps.agentQuestionService
    if (!perguntador || !args.userId) {
      resumo.falhas += 1
      deps.onWarn?.(
        `reconciliação: não deu para escalar de verdade a dúvida presa de ${sessao.sessionName} — ` +
          `${!perguntador ? 'agentQuestionService indefinido' : 'projeto sem userId'}`
      )
      continue
    }

    try {
      // A2 (fix-up L4-T3): fonte ÚNICA do formato (dedup-key-de-duvida.ts).
      // Dentro do try: um hash inválido vindo da marca conta como falha
      // desta sessão, nunca derruba a reconciliação inteira.
      const dedupKey = dedupKeyDeDuvidaDoDev({
        repo: args.repository,
        issue: sessao.issueNumber,
        hash,
      })
      const jaExiste = await deps.prisma.agentQuestion.findFirst({
        where: { projectId: args.projectId, dedupKey },
      })
      if (!jaExiste) {
        // D72 (02/09): a pergunta EXECUTIVA de reserva, determinística —
        // NUNCA a mensagem crua do dev. Antes desta correção, este caminho
        // buscava a última mensagem do dev (`ultimaMensagemDoDevJules`) e
        // encaminhava ela ao dono via `textoDeEscaladaParaODono`, com um
        // único botão "Outro" — exatamente o padrão que o dono flagrou ao
        // vivo (painel/Telegram, tarefa #309 de GitOrchAI/gitorch): pergunta
        // em inglês, sem opções de verdade. `chaveDaSessaoDoDev`/
        // `ultimaMensagemDoDevJules` deixaram de ser necessários aqui.
        // D73/L4-T23: `contextoExecutivoVazio()` aqui é DELIBERADO — este é
        // um caminho de MIGRAÇÃO HISTÓRICA pontual (as 24 sessões presas de
        // 02/09), não o caminho vivo de escalada; monta as 3 lacunas (sem
        // sprint/objetivo/decisão) em vez de buscar quadro/issue/histórico
        // de novo para sessões que já ficaram presas por dias. O texto
        // continua honesto (nunca inventa) e continua citando a tarefa.
        const reserva = perguntaExecutivaDeReserva({
          issueNumber: sessao.issueNumber,
          repository: args.repository,
          contexto: contextoExecutivoVazio(),
        })
        await perguntador.ask(args.userId, args.projectId, {
          text: reserva.text,
          context:
            `Tarefa #${sessao.issueNumber} de ${args.repository} — o dev assíncrono está parado ` +
            'esperando esta decisão (pergunta presa antes do conserto — L4-T3).',
          options: [...reserva.options, buildFreeTextOption()],
          dedupKey,
        })
        resumo.criadas += 1
      }
      // A pergunta existe (nova ou já existia) — migra a marca.
      await registrarEscalada({
        prisma: deps.prisma,
        sessionName: sessao.sessionName,
        hashDaPergunta: hash,
        agora: new Date(),
      })
    } catch (err) {
      resumo.falhas += 1
      // C3 (fix-up L4-T3): NUNCA engole — nível `error` (não `warn`, que se
      // perde), com repo/issue explícitos (nunca segredo: `String(err)` é a
      // mensagem da exceção, nunca a apiKey). A marca fica INALTERADA de
      // propósito (não chama `registrarEscalada`) — a próxima passada tenta
      // de novo.
      const mensagem =
        `reconciliação: não deu para escalar de verdade a dúvida presa de ` +
        `${args.repository}#${sessao.issueNumber} (sessão ${sessao.sessionName}): ${String(err)}`
      deps.onError?.(err, mensagem)
      deps.onWarn?.(mensagem)
    }
  }

  return resumo
}
