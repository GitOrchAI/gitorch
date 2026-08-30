// Camada de dados do painel do owner: a base da API, o mapa de rotas e as
// funções de busca/envio. Fora do React (o app web testa lógica em .ts).
// Portado de ui_kits/painel-owner/ad-api.jsx do handoff — as frases de erro
// são a fonte do desenho e vêm verbatim.
//
// O hook React fino (useBusca, modo demo, intervalo) mora em usePainelBusca.ts,
// não aqui: este módulo só fala HTTP e traduz erro.

import { API_BASE_URL } from '../../lib/api'

export interface PedirDeps {
  fetchImpl?: typeof fetch
}

interface ErroDaApi extends Error {
  status?: number
  code?: string
  corpo?: unknown
}

/** As rotas que o painel consome. Anotadas com a situação, como no bundle. */
export const ROTAS = {
  sessao: '/api/v1/auth/me', // existe
  missoes: '/api/missions', // existe
  projetos: '/api/v1/desejos/projetos', // existe
  desejo: '/api/v1/desejos', // existe (POST)
  perguntas: '/api/v1/setup/agent-questions', // existe (read-only)
  repos: '/api/projects', // existe
  eventos: '/api/events', // existe (SSE)
  status: '/api/v1/status', // existe
  pulso: '/api/v1/painel/pulso', // NOVA nesta leva
  agentes: '/api/v1/painel/agentes', // NOVA nesta leva
  responder: (id: string): string => `/api/v1/painel/decisoes/${id}/responder`, // NOVA nesta leva
  pedidos: '/api/v1/painel/pedidos', // NOVA (leva 2, bloco 2) — a árvore dos desejos
  sprint: '/api/v1/painel/sprint', // NOVA (leva 2, bloco 3) — a sprint corrente
  leitura: '/api/v1/painel/leitura', // NOVA (leva 2, bloco 4) — o que já li do repositório
  ritmo: '/api/v1/painel/ritmo', // FALTA — leva 2
  entregas: '/api/v1/painel/entregas', // NOVA (leva 2, bloco 5) — o que ficou pronto
  ordem: '/api/v1/painel/ordem', // NOVA (leva 2, bloco 7) — escreve a ordem no quadro
  ciclo: '/api/v1/painel/ciclo', // NOVA (leva 2, bloco 6) — o retrabalho medido
  regua: '/api/v1/painel/regua', // NOVA (leva 2, bloco 5) — a régua de pronto do cliente
  sprintDias: '/api/v1/painel/sprint-dias', // NOVA (leva 2, bloco 3) — de quantos dias é a sprint
  historico: '/api/v1/painel/historico', // FALTA — leva 2
  duvidaConfig: '/api/v1/painel/duvida-config', // NOVA (T14) — POST
  timeline: '/api/v1/painel/timeline', // NOVA (T15) — auditoria que não vira spam no Telegram
} as const

/**
 * Chamada base. Sempre com `credentials: 'include'` — a sessão é cookie
 * httpOnly, o JS nunca lê token. `!res.ok` lança um Error carregando
 * `status`, `code` (de `body.code`) e `corpo` para quem quiser traduzir.
 */
export async function pedir<T>(
  caminho: string,
  opcoes: RequestInit = {},
  deps: PedirDeps = {}
): Promise<T> {
  const doFetch = deps.fetchImpl ?? fetch
  const res = await doFetch(`${API_BASE_URL}${caminho}`, { credentials: 'include', ...opcoes })
  if (!res.ok) {
    const corpo = await res.json().catch(() => null)
    const erro = new Error(
      (corpo && typeof corpo === 'object' && 'error' in corpo && typeof corpo.error === 'string'
        ? corpo.error
        : undefined) ?? String(res.status)
    ) as ErroDaApi
    erro.status = res.status
    erro.code =
      corpo && typeof corpo === 'object' && 'code' in corpo && typeof corpo.code === 'string'
        ? corpo.code
        : undefined
    erro.corpo = corpo
    throw erro
  }
  return (res.status === 204 ? null : await res.json()) as T
}

/** GET simples de `caminho`. */
export function buscar<T>(caminho: string, deps: PedirDeps = {}): Promise<T> {
  return pedir<T>(caminho, {}, deps)
}

interface EnviarPedidoArgs {
  projectId: string
  texto: string
  fetchImpl?: typeof fetch
}

export type EnviarPedidoResultado =
  { ok: true; numero: number; endereco: string } | { ok: false; erro: string }

/**
 * Envia um pedido (POST /api/v1/desejos). Traduz cada código de erro para a
 * frase que o produto já escolheu — só o 201 limpa a caixa (a tela cuida disso).
 */
export async function enviarPedido(args: EnviarPedidoArgs): Promise<EnviarPedidoResultado> {
  try {
    const r = await pedir<{ numero: number; endereco: string }>(
      ROTAS.desejo,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: args.projectId, texto: args.texto }),
      },
      { fetchImpl: args.fetchImpl }
    )
    return { ok: true, numero: r.numero, endereco: r.endereco }
  } catch (e) {
    return { ok: false, erro: fraseDoErroDePedido(e as ErroDaApi) }
  }
}

/** Traduz o erro de POST /api/v1/desejos para a frase do produto (verbatim). */
export function fraseDoErroDePedido(e: {
  code?: string
  status?: number
  corpo?: { limite?: number } | unknown
}): string {
  if (e.code === 'REPO_SEM_ACESSO')
    return 'Você não tem mais acesso de escrita a este repositório no GitHub, então não dá para registrar o pedido nele.'
  if (e.code === 'GITHUB_DESCONECTADO')
    return 'Sua conexão com o GitHub não vale mais. Reconecte sua conta e mande de novo.'
  if (e.code === 'REPO_NAO_VERIFICAVEL')
    return 'Não consegui confirmar no GitHub que este repositório ainda é seu. Tente de novo em instantes.'
  if (e.status === 413) {
    const limite =
      e.corpo &&
      typeof e.corpo === 'object' &&
      'limite' in e.corpo &&
      typeof e.corpo.limite === 'number'
        ? e.corpo.limite
        : 60000
    return `Texto grande demais para caber numa issue: o limite é ${limite.toLocaleString('pt-BR')} caracteres.`
  }
  if (e.status === 404) return 'Projeto não encontrado.'
  if (e.status === 400) return 'Escreva o que precisa acontecer antes de pedir.'
  return 'Não consegui registrar o pedido agora.'
}

export type ResponderDecisaoResultado =
  { ok: true; resposta: string } | { ok: false; jaRespondida?: string; erro: string }

/**
 * Responde uma decisão pelo painel (POST /api/v1/painel/decisoes/:id/responder).
 * 409 = a mesma pergunta já foi respondida pelo Telegram: devolve a resposta
 * que existe, para a tela mostrar em vez de sumir com o clique.
 */
export async function responderDecisao(
  id: string,
  resposta: string,
  deps: PedirDeps = {}
): Promise<ResponderDecisaoResultado> {
  try {
    const r = await pedir<{ answer?: string }>(
      ROTAS.responder(id),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resposta }),
      },
      deps
    )
    return { ok: true, resposta: r.answer ?? resposta }
  } catch (e) {
    const erro = e as ErroDaApi
    if (erro.status === 409) {
      const jaRespondida =
        erro.corpo && typeof erro.corpo === 'object' && 'answer' in erro.corpo
          ? String((erro.corpo as { answer?: unknown }).answer ?? '')
          : undefined
      return {
        ok: false,
        ...(jaRespondida ? { jaRespondida } : {}),
        erro: 'Essa decisão já foi respondida pelo Telegram.',
      }
    }
    if (erro.status === 404) return { ok: false, erro: 'Essa decisão não existe mais.' }
    return { ok: false, erro: 'Não consegui enviar a resposta agora.' }
  }
}

export type SalvarDuvidaConfigResultado = { ok: true } | { ok: false; erro: string }

/**
 * Grava quanto o dono quer ver sobre dúvidas do dev assíncrono NESTE projeto
 * (POST /api/v1/painel/duvida-config, ESTEIRA-T14).
 */
export async function salvarDuvidaConfig(
  projectId: string,
  perguntasAoDono: string,
  deps: PedirDeps = {}
): Promise<SalvarDuvidaConfigResultado> {
  try {
    await pedir(
      ROTAS.duvidaConfig,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, perguntasAoDono }),
      },
      deps
    )
    return { ok: true }
  } catch (e) {
    const erro = e as ErroDaApi
    if (erro.status === 404) return { ok: false, erro: 'Este projeto não existe mais.' }
    if (erro.status === 400) return { ok: false, erro: 'Escolha uma das opções antes de salvar.' }
    return { ok: false, erro: 'Não consegui salvar agora. Tente de novo.' }
  }
}

/**
 * Frase em PT-BR a partir do `data` de um evento SSE (/api/events). Provisório:
 * API.md §2.2 pede que este mapeamento more no SERVIDOR para o Telegram dizer a
 * mesma coisa — nesta leva o servidor já manda `descricao` no payload do pulso,
 * e aqui é só o fallback para o stream cru.
 */
export function descreverEventoSSE(raw: string): string {
  try {
    const d = JSON.parse(raw) as { descricao?: string; message?: string }
    return d.descricao || d.message || 'Movimento novo na esteira'
  } catch {
    return 'Movimento novo na esteira'
  }
}
