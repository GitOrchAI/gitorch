import type { AgentQuestionService } from './agent-question.js'
import type { PrismaDevSession } from './dev-session-store.js'
import { registrarEscalada } from './dev-session-store.js'
import { lerMarca } from './pergunta-sem-resposta.js'
import { textoDeEscaladaParaODono } from './texto-de-escalada.js'
import { buildFreeTextOption } from './telegram-bot.js'
import { chaveDaSessaoDoDev, type PrismaParaChaveDoDev } from './chave-do-dev-assincrono.js'
import { ultimaMensagemDoDevJules as ultimaMensagemDoDevJulesReal } from './jules-client.js'

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
    const dedupKey = `duvida-dev:${args.repository}:${sessao.issueNumber}:${hash}`

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
      const jaExiste = await deps.prisma.agentQuestion.findFirst({
        where: { projectId: args.projectId, dedupKey },
      })
      if (!jaExiste) {
        const apiKey = await chaveDaSessaoDoDev(
          {
            prisma: deps.prisma,
            decifrar: deps.decifrar,
            chaveDaInstancia: deps.julesApiKeyDaInstancia,
            ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
          },
          sessao.sessionName
        )
        const buscarUltimaMensagem = deps.ultimaMensagemDoDevJules ?? ultimaMensagemDoDevJulesReal
        // Best-effort: sem conseguir ler a última pergunta do dev, o texto
        // de reserva genérico (sem a pergunta) ainda é uma pergunta de
        // verdade — nunca deixa de escalar por causa disto.
        const perguntaDoDev = await buscarUltimaMensagem({
          apiKey,
          sessionName: sessao.sessionName,
          ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
        }).catch(() => null)
        const texto = textoDeEscaladaParaODono({
          issueNumber: sessao.issueNumber,
          repository: args.repository,
          pergunta: perguntaDoDev,
        })
        await perguntador.ask(args.userId, args.projectId, {
          text: texto,
          context:
            `Tarefa #${sessao.issueNumber} de ${args.repository} — o dev assíncrono está parado ` +
            'esperando esta decisão (pergunta presa antes do conserto — L4-T3).',
          options: [buildFreeTextOption()],
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
      deps.onWarn?.(
        `reconciliação: não deu para escalar de verdade a dúvida presa de ${sessao.sessionName}: ${String(err)}`
      )
    }
  }

  return resumo
}
