import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import {
  getTelegramUpdates,
  handleTelegramUpdate,
  handleTelegramCallback,
  handleTelegramQuestionReply,
  sendTelegramMessage,
  sendTelegramQuestion,
} from '../services/telegram-bot.js'
import { resolveNotifyChatId } from '../services/telegram-link.js'
import { AgentQuestionService, type AgentQuestionRecord } from '../services/agent-question.js'
import { pipelineCheckEnabled } from '../config/pipeline-check.js'

// O ouvido do bot. Sem ele, o deep link do passo 8 abriria o Telegram, o cliente
// apertaria Start... e ninguém estaria escutando — o `chat_id` (a única coisa
// que torna o aviso possível) se perderia e o wizard ficaria "aguardando" para
// sempre.
//
// Long-polling (getUpdates), não webhook — a justificativa está em
// services/telegram-bot.ts. Um único long-poll de 30s por processo.
//
// Sem GITORCH_TELEGRAM_BOT_TOKEN, o plugin simplesmente não escuta (nada de
// bot = nada a ouvir); é assim que uma instalação sem Telegram roda em paz, e é
// por isso que o passo do wizard é opcional.

const POLL_TIMEOUT_SEC = 30
// Backoff quando o Telegram está fora / a rede caiu: não martelar a API.
const ERROR_BACKOFF_MS = 15_000

export const telegramPlugin = fp(async (app: FastifyInstance) => {
  const botToken = process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN']

  // Notifica o dono de uma AgentQuestion nova pelo Telegram (épico W3.3): sem
  // vínculo, no-op — a dúvida já existe e o painel é sempre o fallback
  // (contrato best-effort de AgentQuestionService.ask). Guarda o message_id
  // devolvido pra futura edição/confirmação (`telegramMessageId`). SÓ existe
  // com bot token — sem ele, `ask()` cria a dúvida mas não notifica (degrada
  // com clareza, nunca lança).
  const notifyOwner = botToken
    ? async (question: AgentQuestionRecord): Promise<void> => {
        const chatId = await resolveNotifyChatId(app.prisma, { userId: question.userId })
        if (!chatId) return

        const options = Array.isArray(question.options)
          ? (question.options as unknown as { label: string; value: string }[])
          : []
        const messageId = await sendTelegramQuestion({
          botToken,
          chatId,
          questionId: question.id,
          text: question.text,
          options,
        })
        if (messageId !== undefined) {
          await app.prisma.agentQuestion.update({
            where: { id: question.id },
            data: { telegramMessageId: messageId },
          })
        }
      }
    : undefined

  // A API interna que qualquer agente chama pra registrar uma dúvida
  // (docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md). O
  // notify real (Telegram) e o Cortex (memória de longo prazo das decisões)
  // ficam ligados aqui — é este service que também resolve o clique do botão
  // (`handleTelegramCallback`, abaixo).
  //
  // DECORADO SEMPRE (mesmo sem bot token, mesmo em teste): outras rotas que
  // registram dúvidas (ex.: routes/dev-agent-question.ts, W3.5.1) reusam esta
  // MESMA instância via `app.agentQuestionService`, pra criar E notificar
  // pelo mesmo caminho de produção em vez de duplicar a ligação com o Cortex.
  const agentQuestionService = new AgentQuestionService(app.prisma, {
    ...(notifyOwner ? { notify: notifyOwner } : {}),
    cortex: app.cortex,
  })
  app.decorate('agentQuestionService', agentQuestionService)

  // Dispara uma mensagem simples para o dono de um projeto.
  // Usado para notificar falhas de implantação e outros alertas que não exigem input.
  const sendMessage = botToken
    ? async (projectId: string, text: string): Promise<void> => {
        const project = await app.prisma.project.findUnique({
          where: { id: projectId },
          include: { user: true },
        })
        if (!project) return
        const chatId = await resolveNotifyChatId(app.prisma, project)
        if (!chatId) return

        await sendTelegramMessage({ botToken, chatId, text })
      }
    : async (): Promise<void> => {}
  app.decorate('sendTelegramMessage', sendMessage)

  // Em teste não se abre laço nem socket (paridade com o scheduler): a lógica
  // toda é testada nos serviços, sem rede. Em modo pipeline-check (F2.3/P1-2)
  // também não: a instância de verificação escutando o MESMO bot que a prod
  // viva causaria 409 no getUpdates (ver config/pipeline-check.ts).
  const pipelineCheck = pipelineCheckEnabled()
  if (!botToken || process.env['NODE_ENV'] === 'test' || pipelineCheck) {
    if (!botToken) {
      app.log.info('[Telegram] sem GITORCH_TELEGRAM_BOT_TOKEN — o bot não será ouvido')
    } else if (pipelineCheck) {
      app.log.warn(
        '[Telegram] GITORCH_PIPELINE_CHECK=1: bot NÃO será ouvido (evita 409 contra a prod viva)'
      )
    }
    return
  }

  let stopped = false
  const controller = new AbortController()
  let offset: number | undefined

  const listen = async (): Promise<void> => {
    app.log.info('[Telegram] ouvindo o bot (getUpdates)')
    while (!stopped) {
      try {
        const result = await getTelegramUpdates({
          botToken,
          offset,
          timeoutSec: POLL_TIMEOUT_SEC,
          signal: controller.signal,
        })

        if (result.conflict) {
          // 409: outro processo (ou um webhook) está pendurado no MESMO bot. Os
          // updates estão indo para ele — dizer "tudo certo" aqui seria mentir
          // para o cliente que aperta Start e nunca vincula.
          app.log.error(
            '[Telegram] 409 Conflict no getUpdates: outro ouvinte (ou um webhook) está ativo neste bot. ' +
              'Enquanto isso durar, o Start do cliente NÃO vincula aqui.'
          )
          await sleep(ERROR_BACKOFF_MS)
          continue
        }

        offset = result.nextOffset

        for (const update of result.updates) {
          if (update.callback_query) {
            // Clique num botão de AgentQuestion (épico W3.3) — roteamento
            // próprio, com guard anti cross-tenant embutido em
            // handleTelegramCallback. Nunca é também um /start: são tipos de
            // update mutuamente exclusivos.
            await handleTelegramCallback(
              { prisma: app.prisma, agentQuestionService, botToken },
              update
            )
            continue
          }
          // Reply (o dono respondeu à MENSAGEM da pergunta) — casa com a
          // AgentQuestion aberta via `message.reply_to_message` (feedback do
          // dono: falta uma 4ª resposta manual quando nenhuma opção serve).
          // Só entra aqui quando FOI de fato um reply a uma pergunta nossa;
          // qualquer outra mensagem (ex.: um /start) segue pro fluxo normal
          // logo abaixo.
          const handledAsAnswer = await handleTelegramQuestionReply(
            { prisma: app.prisma, agentQuestionService, botToken },
            update
          )
          if (handledAsAnswer) continue

          const reply = await handleTelegramUpdate(app.prisma, update)
          if (!reply) continue
          await sendTelegramMessage({ botToken, chatId: reply.chatId, text: reply.text })
        }
      } catch (err) {
        if (stopped) return
        app.log.warn(err, '[Telegram] falha ao ouvir o bot; nova tentativa em breve')
        await sleep(ERROR_BACKOFF_MS)
      }
    }
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      // Não segura o processo no shutdown.
      timer.unref?.()
    })

  void listen()

  app.addHook('onClose', async () => {
    stopped = true
    controller.abort()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * A instância ÚNICA de AgentQuestionService com notify (Telegram) + Cortex
     * já ligados (ver acima). Sempre decorada quando este plugin está
     * registrado — outras rotas reusam em vez de instanciar um serviço
     * "mudo" (sem notify) por engano.
     */
    agentQuestionService?: AgentQuestionService
    /**
     * Envia uma mensagem arbitrária para o dono de um projeto via Telegram.
     */
    sendTelegramMessage?: (projectId: string, text: string) => Promise<void>
  }
}

export default telegramPlugin
