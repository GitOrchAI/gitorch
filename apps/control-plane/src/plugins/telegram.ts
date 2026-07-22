import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import {
  getTelegramUpdates,
  handleTelegramUpdate,
  handleTelegramCallback,
  sendTelegramMessage,
  sendTelegramQuestion,
} from '../services/telegram-bot.js'
import { resolveNotifyChatId } from '../services/telegram-link.js'
import { AgentQuestionService, type AgentQuestionRecord } from '../services/agent-question.js'

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

  // Em teste não se abre laço nem socket (paridade com o scheduler): a lógica
  // toda é testada nos serviços, sem rede.
  if (!botToken || process.env['NODE_ENV'] === 'test') {
    if (!botToken) {
      app.log.info('[Telegram] sem GITORCH_TELEGRAM_BOT_TOKEN — o bot não será ouvido')
    }
    return
  }

  // Notifica o dono de uma AgentQuestion nova pelo Telegram (épico W3.3): sem
  // vínculo, no-op — a dúvida já existe e o painel é sempre o fallback
  // (contrato best-effort de AgentQuestionService.ask). Guarda o message_id
  // devolvido pra futura edição/confirmação (`telegramMessageId`).
  const notifyOwner = async (question: AgentQuestionRecord): Promise<void> => {
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

  // A API interna que qualquer agente chama pra registrar uma dúvida
  // (docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md). O
  // notify real (Telegram) e o Cortex (memória de longo prazo das decisões)
  // ficam ligados aqui — é este service que também resolve o clique do botão
  // (`handleTelegramCallback`, abaixo).
  const agentQuestionService = new AgentQuestionService(app.prisma, {
    notify: notifyOwner,
    cortex: app.cortex,
  })

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

export default telegramPlugin
