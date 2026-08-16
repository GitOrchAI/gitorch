import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import {
  getTelegramUpdates,
  handleTelegramUpdate,
  handleTelegramCallback,
  handleTelegramQuestionReply,
  sendTelegramMessage,
  sendTelegramQuestion,
  tratarPedidoDeDesejo,
  type TelegramDesejoDeps,
} from '../services/telegram-bot.js'
import { criarIssueDeDesejo } from '../services/desejo-no-github.js'
import { projetosParaDesejo } from '../services/projetos-do-desejo.js'
import { provaDeEscritaNoUso } from '../services/acesso-ao-repositorio.js'
import {
  resolveNotifyChatId,
  resolveDonoDoChat,
  telegramBotUsername,
} from '../services/telegram-link.js'
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

  // A porta do desejo pelo mensageiro. O pedido em linguagem de gente vira a
  // MESMA issue oficial que a tela cria (ver routes/index.ts) — quem escreve é
  // o serviço compartilhado, então o registro nasce igual venha de onde vier.
  const desejoDeps: TelegramDesejoDeps = {
    // O chat só vale como identidade quando está vinculado a UMA conta: é o
    // vínculo que diz de QUEM ele é, e portanto em qual repositório o pedido
    // pode ser escrito. Chat com duas contas volta `ambiguo` e o pedido é
    // recusado — jamais escrito num repositório sorteado.
    donoDoChat: (chatId) => resolveDonoDoChat(app.prisma, chatId),
    // A MESMA regra da porta HTTP (services/projetos-do-desejo.ts): enquanto
    // cada porta escreveu o próprio filtro, elas divergiram sobre projeto
    // desativado e o dono recebia duas respostas para o mesmo fato.
    projetosDoDono: (userId) => projetosParaDesejo(app.prisma, userId),
    // Defesa em profundidade, e a MESMA função que a porta HTTP usa
    // (routes/index.ts): o acesso ao repositório foi provado uma vez, no
    // wizard, e o endereço virou `project.wingId` para sempre. Removido da
    // organização depois, o dono continuaria mandando pedido daqui e o produto
    // escreveria no repositório alheio com a credencial da instalação.
    confirmarAcesso: provaDeEscritaNoUso(app.engineConnections),
    // Comando endereçado a outro bot do grupo não é nosso. O nome sai da mesma
    // fonte que monta o deep link do wizard.
    nomeDoBot: telegramBotUsername(),
    criarIssue: ({ repo, titulo, corpo, etiquetas }) =>
      criarIssueDeDesejo({
        repo,
        titulo,
        corpo,
        etiquetas,
        log: { onError: (m) => app.log.error(m), onWarn: (m) => app.log.warn(m) },
      }),
    registrarFalha: (erro) => app.log.error(erro, '[Telegram] falha ao registrar o desejo'),
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

          // `/desejo` (ou `/quero`): o pedido do dono em linguagem natural.
          // Vem depois do reply porque uma resposta a uma dúvida do agente é
          // outra conversa, e antes do /start porque mensagem solta que não é
          // desejo continua caindo no fluxo normal.
          const desejo = await tratarPedidoDeDesejo(desejoDeps, update)
          if (desejo) {
            await sendTelegramMessage({ botToken, chatId: desejo.chatId, text: desejo.text })
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

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * A instância ÚNICA de AgentQuestionService com notify (Telegram) + Cortex
     * já ligados (ver acima). Sempre decorada quando este plugin está
     * registrado — outras rotas reusam em vez de instanciar um serviço
     * "mudo" (sem notify) por engano.
     */
    agentQuestionService?: AgentQuestionService
  }
}

export default telegramPlugin
