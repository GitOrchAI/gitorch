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
  tratarCliqueDeProjeto,
  answerTelegramCallback,
  zerarTecladoDaMensagem,
  type TelegramDesejoDeps,
} from '../services/telegram-bot.js'
import { criarIssueDeDesejo } from '../services/desejo-no-github.js'
import { PRAZO_DO_PENDENTE_MS } from '../services/desejo-pendente.js'
import { projetosParaDesejo } from '../services/projetos-do-desejo.js'
import { provaDeEscritaNoUso } from '../services/acesso-ao-repositorio.js'
import {
  resolveNotifyChatId,
  resolveDonoDoChat,
  telegramBotUsername,
} from '../services/telegram-link.js'
import { AgentQuestionService, type AgentQuestionRecord } from '../services/agent-question.js'
import { pipelineCheckEnabled, type PipelineErrorMetadata } from '../config/pipeline-check.js'
import { traduzirErroParaUsuario, type SetupErrorCode } from '../lib/setup-errors.js'

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

  // NUNCA `app.ready()` aqui: chamar ready() de dentro de um plugin BOOTA O ROOT, e todo
  // `app.get()` registrado depois (routes/index.ts inteiro, a começar por healthRoutes)
  // estoura AVV_ERR_ROOT_PLG_BOOTED — o processo morre no arranque e o serviço entra em
  // crash-loop. Passou no CI porque o guard acima retorna quando NODE_ENV==='test', então
  // este trecho só executa fora de teste: quebrou em produção, no primeiro restart depois
  // do PR #394 (31/08, 502 no site). `onReady` agenda o mesmo callback sem bootar o root.
  app.addHook('onReady', async () => {
    if ('emitter' in app) {
      // @ts-ignore
      app.emitter.on('pipeline.error', async (metadata: PipelineErrorMetadata) => {
        const ownerEmail = process.env['GITORCH_OWNER_EMAIL']
        if (!ownerEmail) return

        const user = await app.prisma.user.findUnique({
          where: { email: ownerEmail },
          select: { id: true, email: true },
        })
        if (!user) return

        const chatId = await resolveNotifyChatId(app.prisma, {
          userId: user.id,
          user: { email: user.email },
        })
        if (!chatId) return

        // Extrai o code, remove a chave se for algo como "CODE: message"
        let errorCode = metadata.reason
        const match = /^([A-Z_]+):\s/.exec(errorCode)
        if (match && match[1]) {
          errorCode = match[1]
        }

        const translatedReason = traduzirErroParaUsuario(errorCode as SetupErrorCode | null)
        const mitigationIcon = metadata.requiresAction ? '🚨' : '⚙️'
        const actionRequired = metadata.requiresAction ? 'Sim' : 'Não'
        const text = `${mitigationIcon} **Falha no passo:** ${metadata.step}\n**Problema:** ${translatedReason}\n**Ação do sistema:** ${metadata.mitigationAction}\n**Precisa agir?** ${actionRequired}`

        app.log.info({ payload: text }, '[Telegram] enviando aviso de falha na pipeline')

        await sendTelegramMessage({
          botToken,
          chatId,
          text,
        })
      })
    }
  })

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
    // O pedido que ainda não sabe o projeto vive no BANCO, nunca na memória
    // do processo: entre a pergunta e o toque no botão o serviço reinicia
    // várias vezes por dia, e o dono clicaria no vazio.
    guardarPendente: async ({ userId, chatId, texto }) => {
      // Limpeza oportunista, aqui e não num cron: quem escreve um pedido novo
      // é exatamente quem pode ter deixado pedidos velhos para trás. Sem isto
      // a tabela só cresce — nada mais no produto apaga uma linha dela.
      try {
        await app.prisma.pedidoDeDesejoPendente.deleteMany({
          where: { userId, createdAt: { lt: new Date(Date.now() - PRAZO_DO_PENDENTE_MS) } },
        })
      } catch (erro) {
        // Faxina que falha não pode impedir o pedido de nascer.
        app.log.warn(erro, '[Telegram] limpeza de pedidos pendentes vencidos falhou')
      }
      return app.prisma.pedidoDeDesejoPendente.create({
        data: { userId, chatId, texto },
        select: { id: true },
      })
    },
    lerPendente: (id) =>
      app.prisma.pedidoDeDesejoPendente.findUnique({
        where: { id },
        select: {
          id: true,
          userId: true,
          chatId: true,
          texto: true,
          usadoEm: true,
          createdAt: true,
        },
      }),
    // Só carimba o que AINDA não foi usado. Assim duas entregas do mesmo
    // clique disputando entre si só deixam uma passar — e quem perde recebe
    // `false`, não uma exceção: perder a disputa não é falha, é a outra
    // entrega tendo registrado o pedido.
    marcarPendenteUsado: async (id) => {
      const alterados = await app.prisma.pedidoDeDesejoPendente.updateMany({
        where: { id, usadoEm: null },
        data: { usadoEm: new Date() },
      })
      return alterados.count > 0
    },
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
            // O toque no botão de PROJETO vem primeiro porque ele reconhece o
            // que é seu pelo prefixo e devolve `null` para todo o resto — a
            // dúvida do PO, que viaja no mesmo canal, segue intacta logo abaixo.
            const escolha = await tratarCliqueDeProjeto(desejoDeps, update)
            if (escolha) {
              // Tirar o "reloginho" do botão vem antes da resposta: é o único
              // sinal de que o toque foi recebido, e o registro da issue leva
              // segundos.
              await answerTelegramCallback({ botToken, callbackQueryId: escolha.callbackQueryId })
              // Botão usado para de ser clicável. Sem isto ele fica no
              // histórico parecendo vivo, e o dono toca de novo esperando algo.
              await zerarTecladoDaMensagem({
                botToken,
                chatId: escolha.chatId,
                messageId: update.callback_query.message?.message_id,
              })
              // Texto vazio é a reentrega do mesmo clique: a primeira já
              // respondeu, e repetir seria falar duas vezes com o dono.
              if (escolha.text !== '') {
                const entregue = await sendTelegramMessage({
                  botToken,
                  chatId: escolha.chatId,
                  text: escolha.text,
                })
                // A issue já nasceu e o pendente já foi carimbado. Se o recado
                // não chegou, o dono fica sem saber — e isso tem que aparecer
                // no log, nunca sumir.
                if (!entregue) {
                  app.log.error(
                    { chatId: escolha.chatId },
                    '[Telegram] pedido registrado mas a confirmação não chegou ao dono'
                  )
                }
              }
              continue
            }
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
            await sendTelegramMessage({
              botToken,
              chatId: desejo.chatId,
              text: desejo.text,
              ...(desejo.teclado ? { teclado: desejo.teclado } : {}),
            })
            continue
          }

          if (update.message?.text?.trim().startsWith('/esperas')) {
            const chatId = update.message?.chat?.id
            if (chatId !== undefined && chatId !== null) {
              const waitingMissions = await app.prisma.mission.findMany({
                where: {
                  status: 'waiting',
                  waitingReason: { not: null },
                },
                select: {
                  waitingReason: true,
                  payload: true,
                },
              })

              let text = ''
              if (waitingMissions.length === 0) {
                text = '0 entregas aguardando.'
              } else {
                const parts = waitingMissions.map((m) => {
                  const payload = m.payload as {
                    issueNumber?: number
                    issue_number?: number
                  } | null
                  const issueNumber = payload?.issueNumber ?? payload?.issue_number
                  const reason = m.waitingReason?.replace(/\n/g, ' ') || 'Motivo não especificado'
                  return issueNumber ? `#${issueNumber} - ${reason}` : reason
                })
                text = `${waitingMissions.length} entregas aguardando: ${parts.join(', ')}`
              }

              await sendTelegramMessage({
                botToken,
                chatId: String(chatId),
                text,
              })
            }
            continue
          }

          // `/wishlist` continua com a resposta de orientação que já existia na
          // linha principal. Fica DEPOIS do desejo porque são coisas diferentes:
          // aqui só se explica a sintaxe, enquanto `/desejo` e `/quero` abrem o
          // pedido de verdade.
          if (update.message?.text?.trim().startsWith('/wishlist')) {
            const chatId = update.message?.chat?.id
            if (chatId !== undefined && chatId !== null) {
              await sendTelegramMessage({
                botToken,
                chatId: String(chatId),
                text: 'Use /wishlist add <item>',
              })
            }
            continue
          }

          const reply = await handleTelegramUpdate(app.prisma, update, { agentQuestionService })
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
