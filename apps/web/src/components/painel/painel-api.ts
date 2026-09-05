// Camada de dados do painel do owner: a base da API, o mapa de rotas e as
// funções de busca/envio. Fora do React (o app web testa lógica em .ts).
// Portado de ui_kits/painel-owner/ad-api.jsx do handoff — as frases de erro
// são a fonte do desenho e vêm verbatim.
//
// O hook React fino (useBusca, modo demo, intervalo) mora em usePainelBusca.ts,
// não aqui: este módulo só fala HTTP e traduz erro.

import { API_BASE_URL } from '../../lib/api'
import type { ArvorePayload, NoDaArvore } from './painel-tipos'

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
  arvoreDoPedido: '/api/v1/painel/pedidos/arvore', // NOVA (D2, leva 3) — fase→épico→feature→task de UM pedido
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
  respostasAoDev: '/api/v1/painel/respostas-ao-dev', // NOVA (D69) — o que o time respondeu ao dev em nome do dono
  corrigirRespostaAoDev: (id: string): string => `/api/v1/painel/respostas-ao-dev/${id}/corrigir`, // NOVA (D69) — POST
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

/**
 * Busca a árvore de UM pedido (fase→épico→feature→task).
 *
 * Chamada só quando o dono expande a linha daquele pedido — nunca junto da
 * lista (ver o comentário de CONSULTA_ARVORE no control-plane: pendurar a
 * árvore de todos os pedidos de uma vez estouraria o teto de nós do GraphQL
 * do GitHub). `projeto` e `numero` vêm do próprio `PedidoView` que a linha já
 * tem em mãos.
 */
export async function buscarArvoreDoPedido(
  projeto: string,
  numero: number,
  deps: PedirDeps = {}
): Promise<NoDaArvore[]> {
  const qs = `?projeto=${encodeURIComponent(projeto)}&numero=${numero}`
  const r = await pedir<ArvorePayload>(ROTAS.arvoreDoPedido + qs, {}, deps)
  return r.nos
}

/** Traduz o erro de POST /api/v1/desejos para a frase do produto (verbatim). */
export function fraseDoErroDePedido(e: {
  code?: string
  status?: number
  corpo?: { limite?: number } | unknown
}): string {
  if (e.code === 'REPO_SEM_ACESSO')
    return 'Você não tem mais acesso de escrita a este repositório no GitHub, então não dá para registrar o pedido nele.'
  if (e.code === 'AUTONOMIA_INSUFICIENTE')
    return 'Este projeto está configurado como "Só olhar", que não permite criar pedidos. Mude a autonomia para "Sugerir" ou "Cuidar" e tente de novo.'
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
 * A rota devolve DOIS 409 diferentes (routes/painel.ts) — o `code` no corpo
 * é quem distingue, NUNCA a presença do campo `answer` (fix-up da revisão:
 * todo 409 virava "já foi respondida", inclusive o novo, que na verdade
 * significa que o control-plane não conseguiu registrar a resposta agora):
 *   - `code: 'JA_RESPONDIDA'` — a mesma pergunta já foi respondida pelo
 *     Telegram: devolve a resposta que existe, para a tela mostrar em vez de
 *     sumir com o clique.
 *   - `code: 'ERRO_AO_RESPONDER'` (ou qualquer outro/ausente) — falha real ao
 *     registrar agora; nunca finge que já foi respondida.
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
      const corpo =
        erro.corpo && typeof erro.corpo === 'object'
          ? (erro.corpo as Record<string, unknown>)
          : undefined
      const codigo = corpo && typeof corpo['code'] === 'string' ? corpo['code'] : undefined
      if (codigo === 'JA_RESPONDIDA') {
        const jaRespondida = corpo && 'answer' in corpo ? String(corpo['answer'] ?? '') : undefined
        return {
          ok: false,
          ...(jaRespondida ? { jaRespondida } : {}),
          erro: 'Essa decisão já foi respondida pelo Telegram.',
        }
      }
      return {
        ok: false,
        erro: 'Não deu para registrar sua resposta agora. Tente de novo em instantes.',
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

export type CorrigirRespostaAoDevResultado =
  { ok: true; corrigidoEm: string } | { ok: false; erro: string }

/**
 * Corrige uma resposta que o time deu ao DEV em nome do dono (D69, POST
 * /api/v1/painel/respostas-ao-dev/:id/corrigir). Vira um comentário REAL na
 * issue do dev — não há sessão viva garantida a esta altura (o aprendizado
 * pode ser de dias atrás), então o controle-plane usa o mesmo canal de
 * retaguarda que a correção de suposição do RA já usa.
 */
export async function corrigirRespostaAoDev(
  id: string,
  texto: string,
  deps: PedirDeps = {}
): Promise<CorrigirRespostaAoDevResultado> {
  try {
    const r = await pedir<{ corrigidoEm: string }>(
      ROTAS.corrigirRespostaAoDev(id),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto }),
      },
      deps
    )
    return { ok: true, corrigidoEm: r.corrigidoEm }
  } catch (e) {
    const erro = e as ErroDaApi
    if (erro.status === 400) return { ok: false, erro: 'Escreva a correção.' }
    if (erro.status === 404) return { ok: false, erro: 'Registro não encontrado.' }
    if (erro.status === 409) {
      return { ok: false, erro: 'Este registro não tem uma tarefa vinculada para corrigir.' }
    }
    if (erro.status === 403) {
      const mensagem =
        erro.corpo && typeof erro.corpo === 'object' && 'error' in erro.corpo
          ? String((erro.corpo as Record<string, unknown>)['error'] ?? '')
          : ''
      return { ok: false, erro: mensagem || 'Este projeto não permite esta ação agora.' }
    }
    return {
      ok: false,
      erro: 'Não consegui publicar a correção agora. Tente de novo em instantes.',
    }
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

/** O que POST /painel/ordem devolve quando a escrita no quadro deu certo. */
export interface RespostaDaOrdem {
  /** A frase do servidor: "Reordenei N pedido(s)...". */
  oQueFiz: string
  /** Números que a rota não encontrou no quadro e por isso não moveu. */
  foraDoQuadro?: number[]
  /** O quadro é grande demais e a leitura parou no teto. */
  leituraIncompleta?: boolean
  /** Quantos itens deu para ler antes do corte. */
  itensLidos?: number
}

/**
 * A frase que o dono lê depois de salvar a ordem.
 *
 * O ponto delicado é `foraDoQuadro`: ele só significa "não está no quadro"
 * quando o quadro foi lido INTEIRO. Se a leitura foi cortada no teto, um
 * pedido pode estar lá, numa página que ninguém leu — e dizer "não está no
 * seu quadro" manda o dono caçar um erro dele que não existe. Com a leitura
 * cortada a tela diz o que de fato aconteceu: não apareceu no que deu para ler.
 *
 * Quando nada sobrou, a ordem que ele pediu valeu inteira e não há o que
 * corrigir aqui — o corte fica registrado na timeline. Alarme sem consequência
 * é o que treina alguém a ignorar o alarme que importa.
 */
export function fraseDaOrdem(r: RespostaDaOrdem): string {
  const fora = r.foraDoQuadro?.length ?? 0
  if (fora === 0) return r.oQueFiz

  return r.leituraIncompleta
    ? `${r.oQueFiz} ${fora} pedido(s) não apareceram na parte do quadro que consegui ler (${r.itensLidos} itens) e ficaram como estavam: seu quadro é grande demais para eu ler de uma vez.`
    : `${r.oQueFiz} ${fora} pedido(s) não estão no quadro e ficaram como estavam.`
}
