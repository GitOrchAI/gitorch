import type { PrismaClient } from '@prisma/client'
import { bindChatFromStart } from './telegram-link.js'

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

export interface TelegramUpdate {
  update_id: number
  message?: {
    chat?: { id?: number | string }
    text?: string
    from?: { language_code?: string }
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
    // de volta pro `options[i].value` no clique (`handleTelegramCallback`,
    // épico W3.3.2).
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
