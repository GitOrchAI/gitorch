import type { PrismaClient } from '@prisma/client'
import { bindChatFromStart, telegramBotUsername, type DonoDoChat } from './telegram-link.js'
import { autorLegivel, montarDesejo } from './desejo.js'
import type { AgentQuestionService } from './agent-question.js'

// A ponte HTTP com a API do Telegram: ouvir o bot e falar por ele.
//
// COMO OUVIMOS: long-polling (`getUpdates`), não webhook. A escolha é
// deliberada:
//
//  - o gitorch tem tier SELF-HOST. Uma instalação na máquina do cliente vive
//    atrás de NAT e não tem URL pública com HTTPS válido — um webhook nunca
//    chegaria lá. `getUpdates` só precisa de saída para a internet e funciona em
//    qualquer lugar (nuvem, VM, laptop);
//  - `setWebhook` é GLOBAL e EXCLUSIVO por bot: só existe UMA URL. Staging e
//    produção compartilhando o mesmo bot brigariam pela URL, e quem chamasse
//    setWebhook por último roubaria os updates do outro — em silêncio. Dois
//    ouvintes em polling, ao contrário, produzem um 409 explícito, que a gente
//    detecta e loga (ver `conflict` abaixo);
//  - webhook exige expor mais um endpoint público não autenticado.
//
// O preço é uma requisição longa (30s) em aberto por processo. É barato, e o
// control-plane é um processo só por instalação.

type PrismaLike = Pick<PrismaClient, 'telegramLink'>

// callback_query também precisa ler a AgentQuestion (achar o dono/as opções)
// pra rotear o clique — ver `handleTelegramCallback`.
type PrismaWithQuestions = Pick<PrismaClient, 'telegramLink' | 'agentQuestion'>

/**
 * QUEM digitou. `id` é a pessoa, e não se confunde com o chat: em grupo o
 * `chat.id` é do grupo e o `from.id` é de cada participante. Comando que
 * escreve em repositório de alguém depende dessa distinção (ver
 * `tratarPedidoDeDesejo`).
 */
export interface RemetenteDoTelegram {
  id?: number | string
  language_code?: string
  /** O @ público da pessoa. Opcional no Telegram (nem todo mundo tem um). */
  username?: string
  /** Sempre presente para pessoa; é o nome que ela mesma escolheu exibir. */
  first_name?: string
  last_name?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: {
    chat?: { id?: number | string }
    text?: string
    from?: RemetenteDoTelegram
    /**
     * Presente quando a mensagem é um REPLY (o dono tocou em "Responder" em
     * cima da pergunta) — é o que permite casar texto livre com a
     * `AgentQuestion` original sem precisar de webhook nem de estado extra em
     * memória (ver `handleTelegramQuestionReply`).
     */
    reply_to_message?: { message_id?: number }
  }
  /** Clique num botão inline (ver `sendTelegramQuestion`/`handleTelegramCallback`). */
  callback_query?: {
    id: string
    from?: { id?: number | string }
    /** A mensagem QUE TINHA o teclado — é dela que colapsamos os botões. */
    message?: { message_id?: number; chat?: { id?: number | string } }
    /** Formato esperado: `q:<questionId>:<optionIndex>` — ver `parseQuestionCallbackData`. */
    data?: string
  }
}

export interface TelegramUpdatesResult {
  updates: TelegramUpdate[]
  /** Offset a usar na próxima chamada. Nunca regride (senão o update repete). */
  nextOffset: number | undefined
  /** 409: outro poller (ou um webhook) está pendurado no MESMO bot. */
  conflict: boolean
}

const API = 'https://api.telegram.org'

/**
 * Extrai o token do `/start <token>`. É o ÚNICO comando que interessa: é ele
 * que amarra uma conversa do Telegram (que traz o chat_id) a um usuário nosso.
 * Aceita a forma `/start@NomeDoBot <token>`, que é como o Telegram entrega o
 * comando em grupo.
 */
export function parseStartToken(text: string | undefined): string | null {
  if (!text) return null
  const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)/)
  return match?.[1] ?? null
}

function isStartCommand(text: string | undefined): boolean {
  return !!text && /^\/start(?:@[A-Za-z0-9_]+)?\b/.test(text.trim())
}

/**
 * Reconhece o pedido de desejo vindo do mensageiro.
 *
 * Em grupo, o Telegram entrega o comando com o nome do bot colado
 * ("/desejo@meu_bot ..."); sem tratar isso o comando some no grupo.
 *
 * O comando tem que TERMINAR ali: ou o nome do bot, ou espaço, ou fim da
 * mensagem. Sem esse delimitador, "/desejos" (plural, erro de digitação de quem
 * espera ver a lista) vira o pedido "s" e "/quero-relatorio" vira o pedido
 * "-relatorio" — e como a esteira consome a wishlist ABERTA MAIS RECENTE, esse
 * lixo entra na frente do pedido de verdade e vira tarefa do robô.
 *
 * E o nome colado tem que ser o NOSSO. É a convenção do Telegram: num grupo com
 * vários bots, "/quero@OutroBot cafe" é ordem para o outro bot, e atender
 * assim mesmo escreveria uma issue no repositório do dono a partir de uma ordem
 * que não era para nós. O nome vem da MESMA fonte que monta o deep link do
 * wizard (`telegramBotUsername`), para não existirem duas versões de "quem é
 * este bot"; o Telegram não diferencia maiúscula de minúscula em @username, e
 * aqui também não.
 */
function casarComandoDeDesejo(
  texto: string,
  nomeDoBot: string
): { nosso: false } | { nosso: true; pedido: string } {
  const casado = /^\/(desejo|quero)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(texto.trim())
  if (!casado) return { nosso: false }

  const enderecadoA = casado[2]
  if (enderecadoA !== undefined && enderecadoA.toLowerCase() !== nomeDoBot.trim().toLowerCase()) {
    return { nosso: false }
  }

  return { nosso: true, pedido: (casado[3] ?? '').trim() }
}

export function interpretarPedidoDeDesejo(
  texto: string,
  nomeDoBot: string = telegramBotUsername()
): { ehDesejo: boolean; texto: string } {
  const comando = casarComandoDeDesejo(texto, nomeDoBot)
  if (!comando.nosso || comando.pedido === '') return { ehDesejo: false, texto: '' }
  return { ehDesejo: true, texto: comando.pedido }
}

/**
 * É o NOSSO comando, digitado sem o pedido escrito?
 *
 * Os dois casos caíam no mesmo silêncio, e são fatos diferentes: "/desejos"
 * (erro de digitação) e "/quero@OutroBot" não são assunto nosso e continuam sem
 * resposta — responder seria falar por cima de comando alheio. Já "/desejo"
 * sozinho é alguém PERGUNTANDO como o comando funciona, e o silêncio ali é
 * indistinguível de "o bot está fora do ar": a pessoa desiste do recurso
 * achando que ele não existe.
 *
 * Usa o mesmo casamento de `interpretarPedidoDeDesejo` de propósito: se o
 * delimitador do comando morasse em dois lugares, um deles voltaria a aceitar
 * "/desejos" e o pedido "s" nasceria de novo.
 */
export function ehPedidoDeDesejoSemTexto(
  texto: string,
  nomeDoBot: string = telegramBotUsername()
): boolean {
  const comando = casarComandoDeDesejo(texto, nomeDoBot)
  return comando.nosso && comando.pedido === ''
}

/**
 * Uma passada de escuta. `timeoutSec` é o long-poll do PRÓPRIO Telegram: o
 * servidor segura a conexão até chegar update (ou estourar), então isto não é
 * busy-wait.
 */
export async function getTelegramUpdates(input: {
  botToken: string
  offset?: number | undefined
  timeoutSec?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal | undefined
}): Promise<TelegramUpdatesResult> {
  const f = input.fetchImpl ?? fetch
  const timeout = input.timeoutSec ?? 30
  const params = new URLSearchParams({ timeout: String(timeout) })
  if (input.offset !== undefined) params.set('offset', String(input.offset))
  // Sem isto o Telegram NÃO entrega callback_query (cliques de botão) — só
  // `message`, que é o default histórico da API.
  params.set('allowed_updates', JSON.stringify(['message', 'callback_query']))

  const resp = await f(`${API}/bot${input.botToken}/getUpdates?${params.toString()}`, {
    ...(input.signal ? { signal: input.signal } : {}),
  })

  if (resp.status === 409) {
    return { updates: [], nextOffset: input.offset, conflict: true }
  }
  if (!resp.ok) {
    // Erro transitório do Telegram: sem update e sem avançar o offset. Quem
    // chama tenta de novo — jamais "considera entregue" o que não veio.
    return { updates: [], nextOffset: input.offset, conflict: false }
  }

  const body = (await resp.json().catch(() => ({}))) as { result?: unknown }
  const updates = Array.isArray(body.result) ? (body.result as TelegramUpdate[]) : []
  const maxId = updates.reduce((max, u) => (u.update_id > max ? u.update_id : max), -1)
  return {
    updates,
    nextOffset: maxId >= 0 ? maxId + 1 : input.offset,
    conflict: false,
  }
}

/** Envia uma mensagem. `chat_id` — a API não aceita @username de pessoa. */
export async function sendTelegramMessage(input: {
  botToken: string
  chatId: string
  text: string
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const f = input.fetchImpl ?? fetch
  try {
    const resp = await f(`${API}/bot${input.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
    })
    return resp.ok
  } catch {
    // Telegram fora do ar não pode derrubar a esteira que gerou o aviso.
    return false
  }
}

export interface TelegramQuestionOption {
  label: string
  value: string
}

/**
 * Sentinel do `value` da opção "responda por texto" (feedback do dono: as 3
 * opções fechadas não bastam — "a 4ª resposta tem que ser manual"). NUNCA é
 * gravado como resposta de verdade — é só o marcador que `handleTelegramCallback`
 * reconhece pra instruir em vez de responder (ver ali). Qualquer chamador (hoje
 * `po-rails-mission.ts`, amanhã outro agente) usa `buildFreeTextOption()` em vez
 * de reinventar o valor.
 */
export const FREE_TEXT_OPTION_VALUE = '__gitorch_free_text__'

/**
 * A 4ª opção "escape hatch": quando nenhuma das opções fechadas serve, o dono
 * clica aqui e é instruído a responder (reply) à própria mensagem da pergunta
 * com texto livre — `handleTelegramQuestionReply` casa essa resposta com a
 * pergunta original via `message.reply_to_message`.
 */
export function buildFreeTextOption(
  label = '✍️ Outro (respondo por texto)'
): TelegramQuestionOption {
  return { label, value: FREE_TEXT_OPTION_VALUE }
}

// Labels curtos (ex.: nomes de cores/hex) cabem 2 por linha sem virar
// ilegível no celular; labels longos (frases) vão 1 por linha. Decisão
// simples de propósito — não é um layout engine.
const SHORT_LABEL_MAX_LEN = 16

function buildQuestionKeyboard(
  questionId: string,
  options: TelegramQuestionOption[]
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const buttons = options.map((opt, i) => ({
    text: opt.label,
    // O ÍNDICE viaja no callback_data, não o `value`: o campo tem limite de
    // 64 bytes na API do Telegram, e um value arbitrário (ex.: um hex de cor,
    // mas também poderia ser texto livre) pode estourar isso. O índice mapeia
    // de volta pro `options[i].value` no clique (`handleTelegramCallback`).
    callback_data: `q:${questionId}:${i}`,
  }))
  const perRow = buttons.every((b) => b.text.length <= SHORT_LABEL_MAX_LEN) ? 2 : 1
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow))
  }
  return { inline_keyboard: rows }
}

/**
 * Manda a dúvida do agente com botões (uma `AgentQuestion` — ver
 * services/agent-question.ts). Sem `options`, manda só o texto: é a pergunta
 * aberta, respondida em mensagem livre (fora do escopo desta fase). Devolve o
 * `message_id` (guardado em `telegramMessageId`, pra futura edição/confirmação);
 * `undefined` se o envio falhar — best-effort, quem chama trata (nunca lança).
 */
export async function sendTelegramQuestion(input: {
  botToken: string
  chatId: string
  questionId: string
  text: string
  options: TelegramQuestionOption[]
  fetchImpl?: typeof fetch
}): Promise<number | undefined> {
  const f = input.fetchImpl ?? fetch
  const body: { chat_id: string; text: string; reply_markup?: unknown } = {
    chat_id: input.chatId,
    text: input.text,
  }
  if (input.options.length > 0) {
    body.reply_markup = buildQuestionKeyboard(input.questionId, input.options)
  }
  try {
    const resp = await f(`${API}/bot${input.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return undefined
    const json = (await resp.json().catch(() => ({}))) as { result?: { message_id?: number } }
    return json.result?.message_id
  } catch {
    // Telegram fora do ar não pode derrubar a esteira que gerou a dúvida.
    return undefined
  }
}

/**
 * Some com o "carregando" do botão no celular do dono (a API do Telegram
 * exige essa chamada depois de processar um callback_query, senão o cliente
 * mostra o spinner até dar timeout).
 */
export async function answerTelegramCallback(input: {
  botToken: string
  callbackQueryId: string
  text?: string
  /** true = popup modal (o dono PRECISA ler e fechar) em vez do toast que some sozinho. */
  showAlert?: boolean
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const f = input.fetchImpl ?? fetch
  try {
    const resp = await f(`${API}/bot${input.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: input.callbackQueryId,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.showAlert ? { show_alert: true } : {}),
      }),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Colapsa a pergunta já respondida: reescreve o texto com o que foi
 * escolhido e ZERA o teclado (`inline_keyboard: []`). É a correção do
 * feedback do dono — "os botões não somem depois da escolha" — espelhando o
 * comportamento do AskUserQuestion do Claude Code (a pergunta colapsa e
 * mostra a resposta escolhida). Best-effort por contrato, como todo o resto
 * deste arquivo: uma edição que falha (ex.: mensagem já editada com o MESMO
 * conteúdo — o Telegram devolve 400 "message is not modified") nunca pode
 * quebrar a esteira. `answer()` já é a fonte de verdade; isto é só o espelho
 * visual dela.
 */
export async function collapseTelegramQuestion(input: {
  botToken: string
  chatId: string
  messageId: number
  questionText: string
  chosenLabel: string
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const f = input.fetchImpl ?? fetch
  try {
    const resp = await f(`${API}/bot${input.botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        message_id: input.messageId,
        text: `${input.questionText}\n\n✓ Você escolheu: ${input.chosenLabel}`,
        reply_markup: { inline_keyboard: [] },
      }),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Acha o rótulo a mostrar no colapso pra um `answer` já gravado. Se o valor
 * bate com uma das opções fechadas, usa o label bonito dela; senão (resposta
 * em texto livre, ou uma resposta que veio pelo painel) mostra o texto puro —
 * sempre a VERDADE gravada, nunca o que foi clicado agora (ver o contrato de
 * idempotência de `AgentQuestionService.answer`).
 */
function resolveAnswerLabel(
  options: TelegramQuestionOption[],
  answerValue: string | null | undefined
): string {
  if (!answerValue) return ''
  const match = options.find((o) => o.value === answerValue)
  return match ? match.label : answerValue
}

export interface ParsedQuestionCallback {
  questionId: string
  optionIndex: number
}

/**
 * Parse do `callback_data` de um clique — formato `q:<questionId>:<índice>`
 * (ver `buildQuestionKeyboard`). Robusto por contrato: o Telegram apenas
 * ecoa de volta o que mandamos, mas nunca se confia cegamente num payload que
 * chega de fora — formato torto devolve `null` (o chamador ignora).
 */
export function parseQuestionCallbackData(data: string | undefined): ParsedQuestionCallback | null {
  if (!data) return null
  const match = data.match(/^q:([^:]+):(\d+)$/)
  if (!match) return null
  const questionId = match[1]
  const optionIndex = Number(match[2])
  if (!questionId || !Number.isInteger(optionIndex) || optionIndex < 0) return null
  return { questionId, optionIndex }
}

export interface TelegramCallbackDeps {
  prisma: PrismaWithQuestions
  agentQuestionService: Pick<AgentQuestionService, 'answer'>
  botToken: string
  fetchImpl?: typeof fetch
}

// O que mostrar quando o dono clica em "✍️ Outro" (ver FREE_TEXT_OPTION_VALUE).
// show_alert:true — é uma instrução de ação, precisa ser lida, não um toast
// que some sozinho.
const FREE_TEXT_HINT =
  '✍️ Toque em "Responder" nesta mensagem e digite sua resposta em texto livre.'

/**
 * Roteia UM clique de botão (`callback_query`) pra resposta da `AgentQuestion`
 * correspondente. GUARD anti cross-tenant: só o chat vinculado ao DONO da
 * pergunta (`AgentQuestion.userId`, via `TelegramLink`) pode responder — todo
 * clique de outro chat é IGNORADO em silêncio (nem responde, nem processa,
 * nem revela nada sobre a dúvida). `answer()` já é idempotente do lado do
 * serviço, então um clique repetido (Telegram reentrega updates) é inofensivo.
 *
 * A opção "✍️ Outro" (`FREE_TEXT_OPTION_VALUE`) é tratada à parte: não é uma
 * resposta, é um PEDIDO de instrução — não grava nada, não colapsa, só avisa
 * como responder em texto (ver `handleTelegramQuestionReply`, que trata a
 * resposta em si).
 *
 * Depois de gravar a resposta de verdade, COLAPSA a mensagem (feedback do
 * dono: "os botões não somem depois da escolha") — reescreve o texto com o
 * que foi escolhido e zera o teclado, best-effort (nunca lança se a edição
 * falhar; `answer()` continua sendo a fonte de verdade).
 */
export async function handleTelegramCallback(
  deps: TelegramCallbackDeps,
  update: TelegramUpdate
): Promise<void> {
  const cq = update.callback_query
  if (!cq?.data) return

  const parsed = parseQuestionCallbackData(cq.data)
  if (!parsed) return

  const question = await deps.prisma.agentQuestion.findUnique({ where: { id: parsed.questionId } })
  if (!question) return

  const options = Array.isArray(question.options)
    ? (question.options as unknown as TelegramQuestionOption[])
    : []
  const option = options[parsed.optionIndex]
  if (!option) return

  const clickerChatId = cq.from?.id === undefined || cq.from.id === null ? null : String(cq.from.id)
  if (!clickerChatId) return

  const link = await deps.prisma.telegramLink.findUnique({ where: { userId: question.userId } })
  if (!link || link.status !== 'linked' || !link.chatId || link.chatId !== clickerChatId) {
    // Cross-tenant (ou vínculo perdido/nunca feito): ignora. Nenhuma resposta
    // sai, nada é gravado — o painel continua a via de fallback.
    return
  }

  if (option.value === FREE_TEXT_OPTION_VALUE) {
    await answerTelegramCallback({
      botToken: deps.botToken,
      callbackQueryId: cq.id,
      text: FREE_TEXT_HINT,
      showAlert: true,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    })
    return
  }

  const updated = await deps.agentQuestionService.answer(
    parsed.questionId,
    option.value,
    'telegram'
  )
  await answerTelegramCallback({
    botToken: deps.botToken,
    callbackQueryId: cq.id,
    text: '✓ registrado',
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })

  // A mensagem com o teclado é a MESMA que recebeu o clique — `cq.message` é
  // mais confiável que `telegramMessageId` do banco (que só existe se o
  // notify original conseguiu gravar); cai pro banco só se faltar no update.
  const messageId = cq.message?.message_id ?? question.telegramMessageId ?? undefined
  if (updated && messageId !== undefined && messageId !== null) {
    await collapseTelegramQuestion({
      botToken: deps.botToken,
      chatId: clickerChatId,
      messageId,
      questionText: question.text,
      chosenLabel: resolveAnswerLabel(options, updated.answer),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    })
  }
}

/**
 * Trata uma resposta em TEXTO LIVRE — o dono responde (reply) direto à
 * mensagem da pergunta no Telegram, em vez de clicar num botão (a opção
 * "✍️ Outro" existe pra guiar esse gesto, mas nada impede o dono de simplesmente
 * responder sem clicar nela). O Telegram entrega o vínculo em
 * `message.reply_to_message.message_id`, que casamos com o
 * `AgentQuestion.telegramMessageId` gravado no envio (`sendTelegramQuestion` /
 * `notifyOwner` em plugins/telegram.ts).
 *
 * Por que reply e não outro mecanismo: `getUpdates` (long-polling, ver o
 * cabeçalho do arquivo) não guarda estado de conversa — não há "sessão"
 * esperando a próxima mensagem do chat. `reply_to_message` é o único sinal que
 * o PRÓPRIO Telegram fornece pra amarrar uma mensagem solta a uma pergunta
 * específica, sem inventar estado extra (nem em memória, que morre no
 * restart, nem em banco). Mesmo GUARD anti cross-tenant de
 * `handleTelegramCallback`: só o chat vinculado ao DONO da pergunta responde.
 *
 * Devolve `true` quando tratou o reply (mesmo quando ignora por guard —
 * "tratou" aqui significa "reconheceu que ISTO É um reply", não "gravou uma
 * resposta"); `false` quando não é resposta a pergunta nenhuma — aí quem
 * chama segue pro fluxo normal de mensagem (`handleTelegramUpdate`, ex.: um
 * `/start` solto nunca é também um reply).
 */
export async function handleTelegramQuestionReply(
  deps: TelegramCallbackDeps,
  update: TelegramUpdate
): Promise<boolean> {
  const message = update.message
  if (!message) return false

  const replyToId = message.reply_to_message?.message_id
  if (replyToId === undefined || replyToId === null) return false

  const text = message.text?.trim()
  if (!text) return false

  const rawChatId = message.chat?.id
  if (rawChatId === undefined || rawChatId === null) return false
  const chatId = String(rawChatId)

  // 1º: QUEM é este chat (via TelegramLink) — nunca o contrário (achar a
  // AgentQuestion primeiro por telegramMessageId sozinho seria ambíguo: o
  // Telegram numera message_id POR CHAT, então o mesmo número pode existir em
  // conversas de donos diferentes).
  const link = await deps.prisma.telegramLink.findFirst({ where: { chatId, status: 'linked' } })
  if (!link) return false

  const question = await deps.prisma.agentQuestion.findFirst({
    where: { userId: link.userId, telegramMessageId: replyToId },
  })
  if (!question) return false // reply a uma mensagem que não é pergunta nossa

  const updated = await deps.agentQuestionService.answer(question.id, text, 'telegram')
  if (!updated) return true // pergunta sumiu entre o findFirst e o answer (corrida rara); nada a colapsar

  const options = Array.isArray(question.options)
    ? (question.options as unknown as TelegramQuestionOption[])
    : []
  const messageId = question.telegramMessageId ?? replyToId
  await collapseTelegramQuestion({
    botToken: deps.botToken,
    chatId,
    messageId,
    questionText: question.text,
    chosenLabel: resolveAnswerLabel(options, updated.answer),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  return true
}

type BotLocale = 'pt' | 'es' | 'en'

// A pessoa fala com o bot no idioma DELA (o Telegram manda `language_code`);
// não faz sentido responder em inglês para quem usa o wizard em PT-BR.
function pickLocale(languageCode: string | undefined): BotLocale {
  const code = (languageCode ?? '').toLowerCase()
  if (code.startsWith('pt')) return 'pt'
  if (code.startsWith('es')) return 'es'
  return 'en'
}

const MESSAGES: Record<
  BotLocale,
  { linked: string; invalid: string; noToken: string; chatTaken: string }
> = {
  pt: {
    linked:
      'Pronto, conectado! ✅ A partir de agora eu te aviso por aqui quando uma task do seu projeto travar ou precisar de você.',
    invalid:
      'Este link de conexão expirou ou já foi usado. Abra o passo do Telegram no GitOrch e gere um novo.',
    chatTaken:
      'Esta conversa já está conectada a outra conta do GitOrch. Desconecte a outra conta, ou conecte esta em outra conversa — duas contas na mesma conversa deixariam eu sem saber de quem é cada pedido.',
    noToken:
      'Oi! Para eu saber quem é você, use o botão "Conectar meu Telegram" no passo do Telegram do GitOrch — é o link de lá que faz a ligação.',
  },
  es: {
    linked:
      '¡Listo, conectado! ✅ A partir de ahora te aviso por aquí cuando una tarea de tu proyecto se atasque o necesite de ti.',
    invalid:
      'Este enlace de conexión caducó o ya fue usado. Abre el paso de Telegram en GitOrch y genera uno nuevo.',
    chatTaken:
      'Esta conversación ya está conectada a otra cuenta de GitOrch. Desconecta la otra cuenta, o conecta esta en otra conversación — dos cuentas en la misma conversación me dejarían sin saber de quién es cada pedido.',
    noToken:
      '¡Hola! Para saber quién eres, usa el botón "Conectar mi Telegram" en el paso de Telegram de GitOrch — es ese enlace el que hace la conexión.',
  },
  en: {
    linked:
      "You're connected! ✅ From now on I'll ping you here whenever a task in your project gets stuck or needs you.",
    invalid:
      'This connection link has expired or was already used. Open the Telegram step in GitOrch and generate a new one.',
    chatTaken:
      'This chat is already connected to another GitOrch account. Disconnect the other account, or connect this one in a different chat — two accounts in the same chat would leave me unable to tell whose request is whose.',
    noToken:
      'Hi! To know who you are, use the "Connect my Telegram" button on the GitOrch Telegram step — that link is what ties us together.',
  },
}

/** Projeto do dono, do ponto de vista de "para qual repositório vai o pedido". */
export interface ProjetoParaDesejo {
  id: string
  nome: string
  repo: string
}

export interface TelegramDesejoDeps {
  /**
   * De quem é este chat (vínculo do Telegram). Devolve `ambiguo` quando o mesmo
   * chat aparece em duas contas — aí o pedido é RECUSADO em vez de cair num
   * repositório sorteado (ver `resolveDonoDoChat`).
   */
  donoDoChat: (chatId: string) => Promise<DonoDoChat>
  /** Projetos daquele dono — é entre eles que o pedido escolhe o repositório. */
  projetosDoDono: (userId: string) => Promise<ProjetoParaDesejo[]>
  /**
   * A prova, NO MOMENTO DO USO, de que aquele dono ainda pode escrever naquele
   * repositório — a MESMA da porta HTTP (routes/desejos.ts). Lança
   * `AcessoNaoVerificavelError` quando não dá para saber, e aí a resposta é
   * recusa temporária, nunca permissão.
   */
  confirmarAcesso: (repo: string, userId: string) => Promise<boolean>
  /** O MESMO caminho de criação de issue usado pela porta HTTP do desejo. */
  criarIssue: (args: {
    repo: string
    titulo: string
    corpo: string
    etiquetas: string[]
  }) => Promise<{ numero: number }>
  /** Onde a falha é registrada. Nunca vai para o chat: pode conter credencial. */
  registrarFalha?: (erro: unknown) => void
  /** Prazo do registro no GitHub. Só os testes mexem; ver `PRAZO_DA_ISSUE_MS`. */
  prazoDaIssueMs?: number
  /** Qual bot é este. Só os testes mexem; ver `interpretarPedidoDeDesejo`. */
  nomeDoBot?: string
}

/**
 * Prazo máximo do registro da issue, visto do bot.
 *
 * O laço de escuta é ÚNICO e sequencial (ver o cabeçalho deste arquivo): tudo o
 * que trava dentro dele trava o bot inteiro. Uma api.github.com pendurada
 * deixaria de responder não só a este pedido, mas ao "/start <token>" de outro
 * cliente no meio do wizard — e o vínculo dele nunca aconteceria.
 *
 * Menor que o long-poll de 30s de propósito: o prazo tem que estourar ANTES de
 * a rodada seguinte de updates ficar para trás. `criarIssueDeDesejo` já tem o
 * seu próprio prazo de rede; este é a rede de segurança do LAÇO, que vale para
 * qualquer implementação de `criarIssue` (inclusive uma que trave sem rede).
 */
export const PRAZO_DA_ISSUE_MS = 15_000

/**
 * Devolve o que a promessa devolver, ou LANÇA quando o prazo estoura. Nunca
 * deixa o temporizador vivo (o `finally`) nem segura o processo (`unref`).
 */
async function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const relogio = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`prazo de ${ms}ms estourado`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promessa, relogio])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Quando o dono tem mais de um projeto, o pedido diz a qual deles pertence com
// o endereço do repositório antes de dois-pontos ("dono/loja: quero busca por
// cor"). Sem isso, o dono de dois projetos ficaria sem saída: o bot pediria o
// projeto e não haveria como informá-lo. Só é lido quando há ambiguidade de
// verdade — com um projeto só, dois-pontos no meio da frase continua sendo
// texto comum.
const PREFIXO_DO_PROJETO = /^([^:\n]{1,80}):\s*([\s\S]+)$/

/**
 * Qual projeto recebe o pedido.
 *
 * O REPOSITÓRIO é o identificador de verdade: o banco garante
 * `@@unique([userId, wingId])`, então "dono/loja" aponta para um projeto só
 * deste dono. O NOME não garante nada — nada impede dois projetos chamados
 * "Loja", e escolher o primeiro deixaria o segundo inalcançável para sempre,
 * com o pedido caindo no repositório errado sem ninguém perceber.
 *
 * Por isso o nome continua valendo como atalho, mas SÓ quando ele identifica um
 * projeto só. Empatou, o bot pergunta de novo (listando os endereços) em vez de
 * sortear.
 */
function acharProjeto(
  projetos: ProjetoParaDesejo[],
  pedido: string
): { projeto: ProjetoParaDesejo; texto: string } | null {
  const primeiro = projetos[0]
  if (projetos.length === 1 && primeiro) return { projeto: primeiro, texto: pedido }

  const casado = PREFIXO_DO_PROJETO.exec(pedido)
  if (!casado) return null
  const escolha = (casado[1] ?? '').trim().toLowerCase()
  const resto = (casado[2] ?? '').trim()
  if (resto === '') return null

  const porRepo = projetos.find((p) => p.repo.trim().toLowerCase() === escolha)
  if (porRepo) return { projeto: porRepo, texto: resto }

  const porNome = projetos.filter((p) => p.nome.trim().toLowerCase() === escolha)
  const unico = porNome.length === 1 ? porNome[0] : undefined
  return unico ? { projeto: unico, texto: resto } : null
}

/**
 * Como o dono vê cada projeto na hora de escolher: o endereço (que é o que ele
 * DIGITA, e é único) com o nome ao lado, que é o que ele reconhece.
 */
function rotularProjeto(p: ProjetoParaDesejo): string {
  const nome = p.nome.trim()
  return nome === '' || nome.toLowerCase() === p.repo.trim().toLowerCase()
    ? p.repo
    : `${p.repo} (${nome})`
}

/**
 * Traduz o remetente do Telegram para a assinatura ÚNICA do desejo
 * (`services/desejo.ts`). A regra de como a assinatura se parece vive lá, e é a
 * mesma da porta HTTP; aqui só se diz de onde saem o nome e o @ nesta porta.
 */
function autorDoTelegram(
  from: RemetenteDoTelegram | undefined,
  identificadorDaConta: string
): string {
  const nome = [from?.first_name, from?.last_name]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p !== '')
    .join(' ')
  return autorLegivel({ nome, arroba: from?.username ?? null }, identificadorDaConta)
}

const MENSAGENS_DE_DESEJO: Record<
  BotLocale,
  {
    semVinculo: string
    soNoPrivado: string
    chatAmbiguo: string
    semProjeto: string
    falhou: string
    /** O dono perdeu o acesso de escrita ao repositório do projeto. */
    semAcessoAoRepositorio: (projeto: string) => string
    /** Não deu para confirmar o acesso agora — recusa TEMPORÁRIA. */
    acessoNaoVerificavel: string
    /** Resposta a quem digitou só o comando: um exemplo, não um erro. */
    comoUsar: string
    /** `exemplo` é o endereço a digitar; `lista`, o que o dono reconhece. */
    qualProjeto: (exemplo: string, lista: string[]) => string
    criado: (numero: number, endereco: string, projeto: string) => string
  }
> = {
  pt: {
    soNoPrivado:
      'Só registro pedidos na conversa privada de quem é dono da conta: em grupo eu não tenho como provar quem é quem, e o pedido vira tarefa de verdade no repositório. Me chame no privado e mande o /desejo por lá.',
    chatAmbiguo:
      'Esta conversa está conectada a mais de uma conta do GitOrch, então eu não sei em qual repositório registrar. Deixe só uma conta conectada aqui e mande de novo.',
    semVinculo:
      'Ainda não sei quem é você por aqui. Abra o passo do Telegram no GitOrch e use o botão "Conectar meu Telegram" — depois disso o /desejo funciona.',
    semProjeto:
      'Você ainda não tem nenhum projeto no GitOrch. Cadastre um repositório e eu registro seus pedidos nele.',
    falhou: 'Não consegui registrar seu pedido agora. Tente de novo em alguns minutos.',
    semAcessoAoRepositorio: (projeto) =>
      `Você não tem mais acesso de escrita a ${projeto} no GitHub, então não posso registrar o pedido lá. Se isso for engano, peça de volta o acesso ao repositório e mande de novo.`,
    acessoNaoVerificavel:
      'Não consegui confirmar agora, no GitHub, que esse repositório ainda é seu. Tente de novo em alguns minutos.',
    comoUsar:
      'Escreva o pedido junto com o comando, em linguagem de gente. Assim:\n\n/desejo quero que o site aceite avaliação com foto\n\nEu registro isso como uma tarefa no seu repositório.',
    qualProjeto: (exemplo, lista) =>
      `Você tem mais de um projeto. Diga qual, assim: /desejo ${exemplo}: o que você quer.\n\nSeus projetos: ${lista.join(', ')}`,
    criado: (numero, endereco, projeto) =>
      `Anotado! ✅ Registrei seu pedido em ${projeto} como o item nº ${numero}.\n${endereco}`,
  },
  es: {
    soNoPrivado:
      'Solo registro pedidos en la conversación privada de quien es dueño de la cuenta: en un grupo no puedo probar quién es quién, y el pedido se vuelve una tarea real en el repositorio. Escríbeme en privado y manda el /desejo por allí.',
    chatAmbiguo:
      'Esta conversación está conectada a más de una cuenta de GitOrch, así que no sé en qué repositorio registrar. Deja solo una cuenta conectada aquí y mándalo de nuevo.',
    semVinculo:
      'Todavía no sé quién eres por aquí. Abre el paso de Telegram en GitOrch y usa el botón "Conectar mi Telegram" — después de eso /desejo funciona.',
    semProjeto:
      'Aún no tienes ningún proyecto en GitOrch. Registra un repositorio y anotaré tus pedidos allí.',
    falhou: 'No conseguí registrar tu pedido ahora. Inténtalo de nuevo en unos minutos.',
    semAcessoAoRepositorio: (projeto) =>
      `Ya no tienes acceso de escritura a ${projeto} en GitHub, así que no puedo registrar el pedido allí. Si es un error, pide de vuelta el acceso al repositorio y mándalo otra vez.`,
    acessoNaoVerificavel:
      'No pude confirmar ahora, en GitHub, que ese repositorio siga siendo tuyo. Inténtalo de nuevo en unos minutos.',
    comoUsar:
      'Escribe el pedido junto con el comando, en lenguaje normal. Así:\n\n/desejo quiero que el sitio acepte reseñas con foto\n\nLo registro como una tarea en tu repositorio.',
    qualProjeto: (exemplo, lista) =>
      `Tienes más de un proyecto. Dime cuál, así: /desejo ${exemplo}: lo que quieres.\n\nTus proyectos: ${lista.join(', ')}`,
    criado: (numero, endereco, projeto) =>
      `¡Anotado! ✅ Registré tu pedido en ${projeto} como el ítem nº ${numero}.\n${endereco}`,
  },
  en: {
    soNoPrivado:
      "I only record requests in the account owner's private chat: in a group I can't prove who is who, and a request becomes a real task in the repository. Message me privately and send /desejo there.",
    chatAmbiguo:
      "This chat is connected to more than one GitOrch account, so I don't know which repository to record it in. Leave only one account connected here and send it again.",
    semVinculo:
      'I don\'t know who you are here yet. Open the Telegram step in GitOrch and use the "Connect my Telegram" button — after that /desejo works.',
    semProjeto:
      "You don't have any project in GitOrch yet. Add a repository and I'll record your requests there.",
    falhou: "I couldn't record your request right now. Please try again in a few minutes.",
    semAcessoAoRepositorio: (projeto) =>
      `You no longer have write access to ${projeto} on GitHub, so I can't record the request there. If that's a mistake, ask for repository access again and send it once more.`,
    acessoNaoVerificavel:
      "I couldn't confirm with GitHub right now that this repository is still yours. Please try again in a few minutes.",
    comoUsar:
      'Write the request together with the command, in plain words. Like this:\n\n/desejo I want the site to accept reviews with photos\n\nI record that as a real task in your repository.',
    qualProjeto: (exemplo, lista) =>
      `You have more than one project. Tell me which one, like this: /desejo ${exemplo}: what you want.\n\nYour projects: ${lista.join(', ')}`,
    criado: (numero, endereco, projeto) =>
      `Got it! ✅ I recorded your request in ${projeto} as item #${numero}.\n${endereco}`,
  },
}

/**
 * Trata uma mensagem de `/desejo` (ou `/quero`): o pedido em linguagem de gente
 * vira a issue oficial no repositório do dono, pela MESMA porta que a tela usa
 * (`montarDesejo` + criação da issue). Devolve o que responder, ou `null`
 * quando a mensagem não é um pedido — aí o fluxo normal do bot segue.
 *
 * QUEM MANDA É A PESSOA, NUNCA O CHAT. O pedido vira issue no repositório do
 * dono e a esteira o executa sozinha (analista → dev → PR → merge), então
 * aceitar "veio de um chat vinculado" seria entregar o repositório do dono a
 * qualquer participante de um grupo — e o vínculo em grupo é suportado
 * (`parseStartToken` aceita `/start@Bot <token>`). O que sabemos provar é uma
 * coisa só: no chat PRIVADO, o `from.id` de quem digitou é o próprio `chat.id`
 * vinculado. Fora disso (grupo, canal, remetente ausente) o pedido é recusado
 * com a explicação — mesmo guard de pessoa que `handleTelegramCallback` já usa
 * para o clique de botão.
 *
 * E o chat só vale como identidade quando está vinculado a UMA conta: é o
 * vínculo que diz de QUEM ele é, e portanto em qual repositório o pedido pode
 * ser escrito. Chat solto — ou conectado a duas contas — não escreve em
 * repositório nenhum.
 */
export async function tratarPedidoDeDesejo(
  deps: TelegramDesejoDeps,
  update: TelegramUpdate
): Promise<{ chatId: string; text: string } | null> {
  const message = update.message
  const rawChatId = message?.chat?.id
  if (rawChatId === undefined || rawChatId === null) return null

  const nomeDoBot = deps.nomeDoBot ?? telegramBotUsername()
  const texto = message?.text ?? ''
  const pedido = interpretarPedidoDeDesejo(texto, nomeDoBot)
  // Comando nosso digitado sem o pedido escrito é PERGUNTA, não mensagem
  // alheia: quem faz isso está tentando descobrir como o comando funciona.
  const semTexto = !pedido.ehDesejo && ehPedidoDeDesejoSemTexto(texto, nomeDoBot)
  if (!pedido.ehDesejo && !semTexto) return null

  const chatId = String(rawChatId)
  const textos = MENSAGENS_DE_DESEJO[pickLocale(message?.from?.language_code)]

  // O exemplo vem antes de qualquer checagem de dono ou de vínculo porque ele
  // não conta nada sobre a conta de ninguém — é a documentação do comando. Quem
  // ainda nem se vinculou também precisa dele, e é o único caminho por onde a
  // pessoa descobre que o pedido vai junto com o comando.
  if (semTexto) return { chatId, text: textos.comoUsar }

  // A prova de que quem digitou é o dono: no chat privado o id da PESSOA é o
  // próprio id do chat. Em grupo os dois diferem (e o do grupo é negativo), em
  // canal não há `from` — nos dois casos não há como provar nada.
  const remetente = message?.from?.id
  const remetenteId = remetente === undefined || remetente === null ? null : String(remetente)
  if (remetenteId === null || remetenteId !== chatId) {
    return { chatId, text: textos.soNoPrivado }
  }

  const dono = await deps.donoDoChat(chatId)
  if (dono.tipo === 'ambiguo') return { chatId, text: textos.chatAmbiguo }
  if (dono.tipo === 'nenhum') return { chatId, text: textos.semVinculo }

  const projetos = await deps.projetosDoDono(dono.userId)
  if (projetos.length === 0) return { chatId, text: textos.semProjeto }

  const alvo = acharProjeto(projetos, pedido.texto)
  if (!alvo) {
    const exemplo = projetos[0]?.repo ?? ''
    return { chatId, text: textos.qualProjeto(exemplo, projetos.map(rotularProjeto)) }
  }

  // O acesso foi provado no cadastro — e só. Daquele momento em diante o
  // endereço virou `wingId` do projeto e ninguém mais perguntou nada. Removido
  // da organização depois, o dono continuaria mandando pedido daqui e o produto
  // escreveria no repositório alheio com a credencial da INSTALAÇÃO. A mesma
  // prova da porta HTTP é refeita aqui, na hora de usar.
  try {
    if (!(await deps.confirmarAcesso(alvo.projeto.repo, dono.userId))) {
      return { chatId, text: textos.semAcessoAoRepositorio(rotularProjeto(alvo.projeto)) }
    }
  } catch (erro) {
    // Não conseguir conferir é recusa TEMPORÁRIA, com o nome certo — nunca
    // permissão. O detalhe vai para o log; o chat recebe o recado de gente.
    deps.registrarFalha?.(erro)
    return { chatId, text: textos.acessoNaoVerificavel }
  }

  const desejo = montarDesejo({
    texto: alvo.texto,
    autor: autorDoTelegram(message?.from, dono.userId),
  })
  try {
    const criada = await comPrazo(
      deps.criarIssue({
        repo: alvo.projeto.repo,
        titulo: desejo.titulo,
        corpo: desejo.corpo,
        etiquetas: desejo.etiquetas,
      }),
      deps.prazoDaIssueMs ?? PRAZO_DA_ISSUE_MS
    )
    const endereco = `https://github.com/${alvo.projeto.repo}/issues/${criada.numero}`
    return { chatId, text: textos.criado(criada.numero, endereco, alvo.projeto.nome) }
  } catch (erro) {
    // A falha do GitHub pode trazer credencial no texto; o chat recebe só o
    // recado de gente, e o detalhe vai para o log.
    deps.registrarFalha?.(erro)
    return { chatId, text: textos.falhou }
  }
}

/**
 * Trata UM update. Devolve o que responder (ou null, se não é assunto nosso).
 * Nunca responde com nada derivado do token do bot — o segredo não vaza nem por
 * mensagem.
 */
export async function handleTelegramUpdate(
  prisma: PrismaLike,
  update: TelegramUpdate
): Promise<{ chatId: string; text: string } | null> {
  const message = update.message
  const rawChatId = message?.chat?.id
  if (rawChatId === undefined || rawChatId === null) return null
  if (!isStartCommand(message?.text)) return null

  const chatId = String(rawChatId)
  const locale = pickLocale(message?.from?.language_code)
  const token = parseStartToken(message?.text)
  if (!token) return { chatId, text: MESSAGES[locale].noToken }

  const result = await bindChatFromStart(prisma, { token, chatId })
  if (result.ok) return { chatId, text: MESSAGES[locale].linked }
  // Recusa por chat ocupado tem causa própria: dizer "link expirou" mandaria a
  // pessoa gerar outro link e bater na mesma parede para sempre.
  return {
    chatId,
    text: result.reason === 'chat_taken' ? MESSAGES[locale].chatTaken : MESSAGES[locale].invalid,
  }
}
