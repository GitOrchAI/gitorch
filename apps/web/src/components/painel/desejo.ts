// A tela de pedir, fora do React (mesma decisão de painel/agent-questions.ts e
// setup/submit-flow.ts: o app web não tem jsdom/testing-library, então o que
// precisa de teste mora aqui, e o componente só desenha).
//
// Esta é a porta de entrada do desejo pelo navegador: o dono descreve em
// linguagem de gente o que quer, e o control-plane registra a issue oficial
// (POST /api/v1/desejos). A issue É o registro — a tela é só uma porta.

/** Um projeto do dono, do jeito que o seletor da tela precisa dele. */
export interface ProjetoDoPainel {
  id: string
  /** Endereço do repositório ("dono/repo") — é o que a pessoa reconhece. */
  repo: string
}

export interface DesejoDeps {
  fetchImpl?: typeof fetch
}

/**
 * Resultado do envio, já traduzido para o que a TELA precisa saber.
 *
 * O erro volta como CHAVE de texto (`locales.ts`), nunca como a mensagem crua
 * do servidor: a recusa do GitHub pode carregar credencial no texto, e o
 * produto é multilíngue — decidir a frase aqui quebraria as duas coisas.
 */
export type ResultadoDoDesejo =
  { ok: true; numero: number; endereco: string } | { ok: false; chaveDoErro: string }

const ERRO_VAZIO = 'dashboard.wishErrorEmpty'
const ERRO_PROJETO = 'dashboard.wishErrorProject'
const ERRO_SESSAO = 'dashboard.wishErrorSession'
const ERRO_GITHUB = 'dashboard.wishErrorGithub'
const ERRO_REDE = 'dashboard.wishErrorNetwork'

/**
 * O que a busca de projetos conseguiu apurar.
 *
 * São dois fatos DIFERENTES e o produto não pode confundi-los: `ok` com lista
 * vazia é "perguntei e o dono realmente não tem projeto"; `indisponivel` é
 * "não consegui perguntar". Achatar os dois num array vazio faria a tela
 * mandar refazer o setup quem já o concluiu — afirmar o que não se sabe.
 */
export type ResultadoDosProjetos =
  { estado: 'ok'; projetos: ProjetoDoPainel[] } | { estado: 'indisponivel' }

const NAO_VERIFICADO: ResultadoDosProjetos = { estado: 'indisponivel' }

/** O que a área de pedido tem permissão de dizer, dado o que se sabe. */
export type EstadoDaTelaDePedir = 'carregando' | 'indisponivel' | 'semProjeto' | 'pronto'

/**
 * Traduz o que se sabe sobre os projetos no que a tela pode AFIRMAR.
 *
 * `null` é "a resposta ainda não chegou" — e enquanto ela não chega a tela não
 * tem o direito de dizer que não há projeto. Só a resposta real e vazia
 * autoriza a frase "conclua o setup".
 */
export function estadoDaTelaDePedir(r: ResultadoDosProjetos | null): EstadoDaTelaDePedir {
  if (r === null) return 'carregando'
  if (r.estado === 'indisponivel') return 'indisponivel'
  return r.projetos.length === 0 ? 'semProjeto' : 'pronto'
}

/**
 * Lista os projetos do dono autenticado.
 *
 * A fonte é `GET /api/v1/setup/status`, que é a única rota do produto filtrada
 * pelo DONO da sessão (`/api/projects` filtra pela ala do GitHub, que nunca
 * casa com a ala do projeto — que guarda "dono/repo"). Um projeto aparece uma
 * vez só mesmo tendo várias missões de setup.
 *
 * NUNCA lança — mas também nunca disfarça: sessão ausente, backend fora, rede
 * caída ou corpo fora do formato voltam como `indisponivel`, para a tela dizer
 * "não consegui verificar" em vez de inventar que a pessoa não tem projeto.
 */
export async function fetchProjetos(
  apiBaseUrl: string,
  deps: DesejoDeps = {}
): Promise<ResultadoDosProjetos> {
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${apiBaseUrl}/api/v1/setup/status`, { credentials: 'include' })
    if (!res.ok) return NAO_VERIFICADO
    const json: unknown = await res.json().catch(() => null)
    return extrairProjetos(json)
  } catch {
    return NAO_VERIFICADO
  }
}

// Anti-fachada: um corpo que não seja `{ missions: [...] }` é resposta que não
// dá para entender — não é prova de ausência de projeto, então volta como
// não-verificado. Já um item torto DENTRO de uma lista boa é descartado
// sozinho, sem derrubar os projetos que vieram inteiros.
function extrairProjetos(json: unknown): ResultadoDosProjetos {
  if (!json || typeof json !== 'object') return NAO_VERIFICADO
  const corpo = json as { missions?: unknown }
  if (!Array.isArray(corpo.missions)) return NAO_VERIFICADO

  const vistos = new Set<string>()
  const projetos: ProjetoDoPainel[] = []
  for (const bruto of corpo.missions) {
    if (!bruto || typeof bruto !== 'object') continue
    const m = bruto as Record<string, unknown>
    if (typeof m['projectId'] !== 'string' || typeof m['wingId'] !== 'string') continue
    if (vistos.has(m['projectId'])) continue
    vistos.add(m['projectId'])
    projetos.push({ id: m['projectId'], repo: m['wingId'] })
  }
  return { estado: 'ok', projetos }
}

/**
 * Manda o pedido para o control-plane registrar a issue de desejo.
 *
 * A validação de texto e de projeto é feita ANTES da rede: sem isso, um dedo
 * escorregado no botão viraria uma ida ao GitHub para nada — e a mensagem de
 * "escreva o pedido" chegaria depois de uma espera sem motivo.
 */
export async function enviarDesejo(
  args: { apiBaseUrl: string; projectId: string; texto: string },
  deps: DesejoDeps = {}
): Promise<ResultadoDoDesejo> {
  const texto = args.texto.trim()
  if (texto === '') return { ok: false, chaveDoErro: ERRO_VAZIO }
  if (args.projectId.trim() === '') return { ok: false, chaveDoErro: ERRO_PROJETO }

  const doFetch = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${args.apiBaseUrl}/api/v1/desejos`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: args.projectId, texto }),
    })
  } catch {
    return { ok: false, chaveDoErro: ERRO_REDE }
  }

  if (!res.ok) return { ok: false, chaveDoErro: chaveDoStatus(res.status) }

  const json: unknown = await res.json().catch(() => null)
  const criada = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  // Sem número não houve issue: dizer "criado" aqui seria anunciar uma entrega
  // que ninguém consegue abrir depois.
  if (!criada || typeof criada['numero'] !== 'number') {
    return { ok: false, chaveDoErro: ERRO_GITHUB }
  }
  return {
    ok: true,
    numero: criada['numero'],
    endereco: typeof criada['endereco'] === 'string' ? criada['endereco'] : '',
  }
}

// Cada recusa vira a explicação do que a PESSOA pode fazer a respeito: 401 é
// sessão vencida (entrar de novo), 404 é projeto que não é dela (escolher
// outro), o resto é falha do nosso lado (tentar de novo).
function chaveDoStatus(status: number): string {
  if (status === 400) return ERRO_VAZIO
  if (status === 401 || status === 403) return ERRO_SESSAO
  if (status === 404) return ERRO_PROJETO
  return ERRO_GITHUB
}
