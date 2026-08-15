import type { PrismaClient } from '@prisma/client'
import { bindChatFromStart } from './telegram-link.js'
import { montarDesejo } from './desejo.js'
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

export interface TelegramUpdate {
  update_id: number
  message?: {
    chat?: { id?: number | string }
    text?: string
    from?: { language_code?: string }
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
 */
export function interpretarPedidoDeDesejo(texto: string): { ehDesejo: boolean; texto: string } {
  const casado = /^\/(desejo|quero)(?:@[\w_]+)?\s*([\s\S]*)$/i.exec(texto.trim())
  if (!casado) return { ehDesejo: false, texto: '' }
  const pedido = (casado[2] ?? '').trim()
  if (pedido === '') return { ehDesejo: false, texto: '' }
  return { ehDesejo: true, texto: pedido }
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

const MESSAGES: Record<BotLocale, { linked: string; invalid: string; noToken: string }> = {
  pt: {
    linked:
      'Pronto, conectado! ✅ A partir de agora eu te aviso por aqui quando uma task do seu projeto travar ou precisar de você.',
    invalid:
      'Este link de conexão expirou ou já foi usado. Abra o passo do Telegram no GitOrch e gere um novo.',
    noToken:
      'Oi! Para eu saber quem é você, use o botão "Conectar meu Telegram" no passo do Telegram do GitOrch — é o link de lá que faz a ligação.',
  },
  es: {
    linked:
      '¡Listo, conectado! ✅ A partir de ahora te aviso por aquí cuando una tarea de tu proyecto se atasque o necesite de ti.',
    invalid:
      'Este enlace de conexión caducó o ya fue usado. Abre el paso de Telegram en GitOrch y genera uno nuevo.',
    noToken:
      '¡Hola! Para saber quién eres, usa el botón "Conectar mi Telegram" en el paso de Telegram de GitOrch — es ese enlace el que hace la conexión.',
  },
  en: {
    linked:
      "You're connected! ✅ From now on I'll ping you here whenever a task in your project gets stuck or needs you.",
    invalid:
      'This connection link has expired or was already used. Open the Telegram step in GitOrch and generate a new one.',
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
  /** Quem é o dono deste chat (vínculo do Telegram). `null` = chat não vinculado. */
  donoDoChat: (chatId: string) => Promise<string | null>
  /** Projetos daquele dono — é entre eles que o pedido escolhe o repositório. */
  projetosDoDono: (userId: string) => Promise<ProjetoParaDesejo[]>
  /** O MESMO caminho de criação de issue usado pela porta HTTP do desejo. */
  criarIssue: (args: {
    repo: string
    titulo: string
    corpo: string
    etiquetas: string[]
  }) => Promise<{ numero: number }>
  /** Onde a falha é registrada. Nunca vai para o chat: pode conter credencial. */
  registrarFalha?: (erro: unknown) => void
}

// Quando o dono tem mais de um projeto, o pedido diz a qual deles pertence com
// o nome antes de dois-pontos ("Loja: quero busca por cor"). Sem isso, o dono
// de dois projetos ficaria sem saída: o bot pediria o projeto e não haveria
// como informá-lo. Só é lido quando há ambiguidade de verdade — com um projeto
// só, dois-pontos no meio da frase continua sendo texto comum.
const PREFIXO_DO_PROJETO = /^([^:\n]{1,80}):\s*([\s\S]+)$/

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

  const projeto = projetos.find(
    (p) => p.nome.trim().toLowerCase() === escolha || p.repo.trim().toLowerCase() === escolha
  )
  return projeto ? { projeto, texto: resto } : null
}

const MENSAGENS_DE_DESEJO: Record<
  BotLocale,
  {
    semVinculo: string
    semProjeto: string
    falhou: string
    qualProjeto: (nomes: string[]) => string
    criado: (numero: number, endereco: string, projeto: string) => string
  }
> = {
  pt: {
    semVinculo:
      'Ainda não sei quem é você por aqui. Abra o passo do Telegram no GitOrch e use o botão "Conectar meu Telegram" — depois disso o /desejo funciona.',
    semProjeto:
      'Você ainda não tem nenhum projeto no GitOrch. Cadastre um repositório e eu registro seus pedidos nele.',
    falhou: 'Não consegui registrar seu pedido agora. Tente de novo em alguns minutos.',
    qualProjeto: (nomes) =>
      `Você tem mais de um projeto. Diga qual, assim: /desejo ${nomes[0]}: o que você quer.\n\nSeus projetos: ${nomes.join(', ')}`,
    criado: (numero, endereco, projeto) =>
      `Anotado! ✅ Registrei seu pedido em ${projeto} como o item nº ${numero}.\n${endereco}`,
  },
  es: {
    semVinculo:
      'Todavía no sé quién eres por aquí. Abre el paso de Telegram en GitOrch y usa el botón "Conectar mi Telegram" — después de eso /desejo funciona.',
    semProjeto:
      'Aún no tienes ningún proyecto en GitOrch. Registra un repositorio y anotaré tus pedidos allí.',
    falhou: 'No conseguí registrar tu pedido ahora. Inténtalo de nuevo en unos minutos.',
    qualProjeto: (nomes) =>
      `Tienes más de un proyecto. Dime cuál, así: /desejo ${nomes[0]}: lo que quieres.\n\nTus proyectos: ${nomes.join(', ')}`,
    criado: (numero, endereco, projeto) =>
      `¡Anotado! ✅ Registré tu pedido en ${projeto} como el ítem nº ${numero}.\n${endereco}`,
  },
  en: {
    semVinculo:
      'I don\'t know who you are here yet. Open the Telegram step in GitOrch and use the "Connect my Telegram" button — after that /desejo works.',
    semProjeto:
      "You don't have any project in GitOrch yet. Add a repository and I'll record your requests there.",
    falhou: "I couldn't record your request right now. Please try again in a few minutes.",
    qualProjeto: (nomes) =>
      `You have more than one project. Tell me which one, like this: /desejo ${nomes[0]}: what you want.\n\nYour projects: ${nomes.join(', ')}`,
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
 * O chat só vale como identidade quando está vinculado: é o vínculo que diz de
 * QUEM é este chat, e portanto em qual repositório o pedido pode ser escrito.
 * Chat solto não escreve em repositório nenhum.
 */
export async function tratarPedidoDeDesejo(
  deps: TelegramDesejoDeps,
  update: TelegramUpdate
): Promise<{ chatId: string; text: string } | null> {
  const message = update.message
  const rawChatId = message?.chat?.id
  if (rawChatId === undefined || rawChatId === null) return null

  const pedido = interpretarPedidoDeDesejo(message?.text ?? '')
  if (!pedido.ehDesejo) return null

  const chatId = String(rawChatId)
  const textos = MENSAGENS_DE_DESEJO[pickLocale(message?.from?.language_code)]

  const userId = await deps.donoDoChat(chatId)
  if (!userId) return { chatId, text: textos.semVinculo }

  const projetos = await deps.projetosDoDono(userId)
  if (projetos.length === 0) return { chatId, text: textos.semProjeto }

  const alvo = acharProjeto(projetos, pedido.texto)
  if (!alvo) return { chatId, text: textos.qualProjeto(projetos.map((p) => p.nome)) }

  const desejo = montarDesejo({ texto: alvo.texto, autor: userId })
  try {
    const criada = await deps.criarIssue({
      repo: alvo.projeto.repo,
      titulo: desejo.titulo,
      corpo: desejo.corpo,
      etiquetas: desejo.etiquetas,
    })
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
  return {
    chatId,
    text: result.ok ? MESSAGES[locale].linked : MESSAGES[locale].invalid,
  }
}
