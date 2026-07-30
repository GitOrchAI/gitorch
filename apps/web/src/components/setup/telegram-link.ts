// Vínculo do Telegram — a lógica, fora do React (mesma decisão de
// engine-status.ts e submit-flow.ts: o app web não tem jsdom/testing-library,
// então o que precisa de teste mora aqui).
//
// O passo 8 pedia um @username e não chamava backend nenhum: o cliente informava
// o Telegram e nunca receberia mensagem — a API do Telegram endereça por
// `chat_id`, e chat_id só existe depois que a pessoa aperta Start no bot. Agora
// o wizard pede o deep link ao backend, o cliente aperta Start, e a tela só diz
// "conectado" quando o BACKEND confirma que capturou o chat_id.

import type { Fetcher, HttpResponse } from './submit-flow'

/**
 * `idle`    — sem vínculo (ou o link venceu): oferece conectar.
 * `pending` — link gerado, esperando o Start do cliente. NÃO é sucesso.
 * `linked`  — o backend capturou o chat_id. Só aqui aparece o ✓.
 * `error`   — falhou de verdade, e a tela diz isso.
 */
export type TelegramLinkState =
  | { phase: 'idle' }
  | { phase: 'pending'; deepLink: string }
  | { phase: 'linked' }
  | { phase: 'error'; message: string }

// Os benefícios REAIS do vínculo, mostrados acima do botão de conectar. Ordem =
// ordem de exibição. 21/07 (W3): a tela prometia 4, mas só 2 existem de
// verdade — perguntas dos agentes com botões (human-in-the-loop, construído
// nesta fase) e alertas de incidente. "Anúncios de novidades" e "/wish" foram
// REMOVIDOS (não existem; viram ciclo próprio) — nada de prometer o que não
// entrega.
export const TELEGRAM_BENEFIT_KEYS = ['setup.tgBenefit1', 'setup.tgBenefit2'] as const

const defaultFetcher: Fetcher = (url, init) => fetch(url, init)

export interface TelegramLinkInput {
  apiBaseUrl: string
  fallbackError: string
}

export interface TelegramLinkDeps {
  fetchImpl?: Fetcher
}

/**
 * Resposta do backend -> estado da tela. Anti-fachada: qualquer coisa que não
 * seja um `linked` explícito NUNCA vira ✓. Um `pending` sem deep link é inútil
 * (não há botão a oferecer) e cai em `idle` em vez de prometer um link que não
 * existe.
 */
export function parseLinkView(json: unknown): TelegramLinkState {
  const body = (json ?? {}) as { status?: unknown; deepLink?: unknown }
  if (body.status === 'linked') return { phase: 'linked' }
  if (body.status === 'pending' && typeof body.deepLink === 'string' && body.deepLink) {
    return { phase: 'pending', deepLink: body.deepLink }
  }
  return { phase: 'idle' }
}

async function readState(
  response: HttpResponse,
  fallbackError: string
): Promise<TelegramLinkState> {
  if (!response.ok) return { phase: 'error', message: fallbackError }
  return parseLinkView(await response.json().catch(() => null))
}

/** Pede o deep link (t.me/<bot>?start=<token>) que o cliente vai abrir. */
export async function startTelegramLink(
  input: TelegramLinkInput,
  deps: TelegramLinkDeps = {}
): Promise<TelegramLinkState> {
  const doFetch = deps.fetchImpl ?? defaultFetcher
  try {
    // POST SEM body — então NÃO mandar `Content-Type: application/json`: o
    // Fastify (backend) rejeita um corpo vazio anunciado como JSON com 400
    // (FST_ERR_CTP_EMPTY_JSON_BODY). Era exatamente o "erro ao conectar" que o
    // dono via — o vínculo quebrava ANTES de capturar o chat_id (o ID do
    // cliente). Sem o header, o POST vazio passa e o deep link é gerado.
    const response = await doFetch(`${input.apiBaseUrl}/api/v1/setup/telegram/link`, {
      method: 'POST',
      credentials: 'include',
    })
    return await readState(response, input.fallbackError)
  } catch {
    return { phase: 'error', message: input.fallbackError }
  }
}

/**
 * Um poll do vínculo. Devolve `null` quando a leitura não aconteceu (429/500/
 * rede): nesse caso a tela MANTÉM o estado atual — um soluço de rede não é
 * notícia sobre o vínculo, não pode virar ✓ nem susto.
 */
export async function readTelegramLink(
  input: TelegramLinkInput,
  deps: TelegramLinkDeps = {}
): Promise<TelegramLinkState | null> {
  const doFetch = deps.fetchImpl ?? defaultFetcher
  try {
    const response = await doFetch(`${input.apiBaseUrl}/api/v1/setup/telegram/status`, {
      credentials: 'include',
    })
    if (!response.ok) return null
    return parseLinkView(await response.json().catch(() => null))
  } catch {
    return null
  }
}
