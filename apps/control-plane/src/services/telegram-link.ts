import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

// Vínculo do Telegram do cliente — o domínio, sem rede (a ponte HTTP com o bot
// vive em telegram-bot.ts).
//
// O FATO que manda nesta arquitetura: a API do Telegram só entrega mensagem a
// quem já falou com o bot, e `sendMessage` endereça por `chat_id`. Um @username
// de pessoa não endereça nada. Então o passo do wizard que capturava "@fulano"
// era incapaz de notificar seja qual for o backend — não era um pedaço faltando,
// era uma promessa impossível.
//
// O caminho real é o deep link com token: o wizard gera um token, o cliente abre
// `t.me/<bot>?start=<token>`, aperta Start, e o bot recebe `/start <token>`. É
// NESSE update que o `chat_id` existe pela primeira vez — e aí ele é amarrado ao
// dono do token.

type PrismaLike = Pick<PrismaClient, 'telegramLink'>

/** Validade do token do deep link. Vencido, não vincula — gera-se um novo. */
export const LINK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** O bot é produto, não infra secreta: o @username dele é público (aparece no link). */
export function telegramBotUsername(): string {
  return process.env['GITORCH_TELEGRAM_BOT_USERNAME'] ?? 'GitOrchAI_bot'
}

export function buildDeepLink(token: string, botUsername = telegramBotUsername()): string {
  return `https://t.me/${botUsername}?start=${token}`
}

/**
 * `unlinked` — nada a caminho (nunca apertou Start, ou o token venceu).
 * `pending`  — deep link vivo, esperando o Start.
 * `linked`   — chat_id capturado: a partir daqui dá para notificar de verdade.
 * Não existe um quarto estado "provavelmente deu certo".
 */
export type TelegramLinkStatus = 'unlinked' | 'pending' | 'linked'

export interface TelegramLinkView {
  status: TelegramLinkStatus
  /** Só enquanto pendente. Vinculado não tem link — não há o que apertar. */
  deepLink: string | null
}

export type BindResult =
  { ok: true; userId: string } | { ok: false; reason: 'unknown_token' | 'expired' }

interface Clock {
  now?: Date | undefined
}

// 24 bytes -> 48 chars hex. O parâmetro `start` do Telegram aceita até 64 chars
// de [A-Za-z0-9_-]; 192 bits de entropia cabem folgados e não estouram o limite.
function newToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Abre (ou reaproveita) o vínculo pendente do usuário e devolve o deep link.
 *
 * Idempotente de propósito: reabrir o passo do wizard NÃO rotaciona um token
 * ainda válido — o link que o cliente já abriu no celular continua funcionando.
 * Já vinculado devolve `linked` e não gera token nenhum: rotacionar aqui
 * desligaria, sem avisar, um Telegram que já estava recebendo.
 */
export async function startTelegramLink(
  prisma: PrismaLike,
  userId: string,
  clock: Clock = {}
): Promise<TelegramLinkView> {
  const now = clock.now ?? new Date()
  const existing = await prisma.telegramLink.findUnique({ where: { userId } })

  if (existing?.status === 'linked' && existing.chatId) {
    return { status: 'linked', deepLink: null }
  }
  if (existing?.token && existing.tokenExpiresAt && existing.tokenExpiresAt > now) {
    return { status: 'pending', deepLink: buildDeepLink(existing.token) }
  }

  const token = newToken()
  const tokenExpiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS)
  await prisma.telegramLink.upsert({
    where: { userId },
    create: { userId, status: 'pending', token, tokenExpiresAt },
    update: { status: 'pending', token, tokenExpiresAt, chatId: null, linkedAt: null },
  })
  return { status: 'pending', deepLink: buildDeepLink(token) }
}

/**
 * A VERDADE do vínculo, para o wizard mostrar. Nunca deriva "vinculado" de ter
 * gerado um link (o erro que este PR inteiro existe para matar): só é `linked`
 * quem tem `chat_id` — e chat_id só nasce de um Start real.
 */
export async function readTelegramLink(
  prisma: PrismaLike,
  userId: string,
  clock: Clock = {}
): Promise<TelegramLinkView> {
  const now = clock.now ?? new Date()
  const link = await prisma.telegramLink.findUnique({ where: { userId } })
  if (!link) return { status: 'unlinked', deepLink: null }
  if (link.status === 'linked' && link.chatId) return { status: 'linked', deepLink: null }
  if (link.token && link.tokenExpiresAt && link.tokenExpiresAt > now) {
    return { status: 'pending', deepLink: buildDeepLink(link.token) }
  }
  // Pendente com token vencido não é "aguardando": é um link morto. A UI oferece
  // conectar de novo em vez de girar para sempre.
  return { status: 'unlinked', deepLink: null }
}

/**
 * O Start chegou: amarra o `chat_id` ao dono do token. Aqui mora a segurança do
 * vínculo — escrita CONDICIONAL (token ainda presente + pendente + não vencido),
 * então o token é de USO ÚNICO mesmo sob corrida: quem chega depois pega
 * `count: 0`. Sem isso, um link vazado permitiria a um terceiro apontar as
 * notificações do dono para o próprio chat.
 */
export async function bindChatFromStart(
  prisma: PrismaLike,
  input: { token: string; chatId: string; now?: Date | undefined }
): Promise<BindResult> {
  const now = input.now ?? new Date()
  const link = await prisma.telegramLink.findFirst({ where: { token: input.token } })
  if (!link) return { ok: false, reason: 'unknown_token' }
  if (!link.tokenExpiresAt || link.tokenExpiresAt <= now) return { ok: false, reason: 'expired' }

  const claimed = await prisma.telegramLink.updateMany({
    where: { token: input.token, status: 'pending', tokenExpiresAt: { gt: now } },
    data: {
      chatId: input.chatId,
      status: 'linked',
      linkedAt: now,
      // Consumido: o mesmo link não vincula duas vezes.
      token: null,
      tokenExpiresAt: null,
    },
  })
  if (claimed.count === 0) return { ok: false, reason: 'unknown_token' }
  return { ok: true, userId: link.userId }
}

/** Projeto, do ponto de vista de "a quem este aviso pertence". */
export interface NotifiableProject {
  userId?: string | null
  user?: { email?: string | null } | null
}

export interface NotifyTargets {
  /** E-mail do dono da INSTÂNCIA (GITORCH_OWNER_EMAIL) — quem somos nós. */
  instanceOwnerEmail?: string | undefined
  /** Nosso chat de operação (GITORCH_TELEGRAM_CHAT_ID). */
  instanceChatId?: string | undefined
}

const sameEmail = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Para QUEM vai o aviso sobre um projeto. Esta função é o coração da correção:
 *
 * 1. o dono do projeto, no chat que ELE vinculou — é o cliente que precisa saber
 *    que a task dele travou;
 * 2. o nosso chat SOMENTE quando o projeto é NOSSO (dono == dono da instância):
 *    aí a notificação é interna de verdade;
 * 3. caso contrário, ninguém.
 *
 * O que NÃO pode existir é o comportamento antigo: todo aviso, de qualquer
 * cliente, caindo no chat da gitorch (via GITORCH_TELEGRAM_CHAT_ID do env) —
 * o cliente nunca era avisado, e o nome do repo/issue dele acabava no nosso
 * chat. Um cliente também jamais pode cair no chat de outro: o chat é sempre
 * buscado pelo `userId` do dono daquele projeto, nunca pelo repositório.
 */
export async function resolveNotifyChatId(
  prisma: PrismaLike,
  project: NotifiableProject,
  targets: NotifyTargets = {}
): Promise<string | null> {
  if (project.userId) {
    const link = await prisma.telegramLink.findUnique({ where: { userId: project.userId } })
    if (link?.status === 'linked' && link.chatId) return link.chatId
  }

  if (
    targets.instanceChatId &&
    sameEmail(project.user?.email, targets.instanceOwnerEmail) &&
    project.userId
  ) {
    return targets.instanceChatId
  }

  return null
}
