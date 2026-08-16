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
const ERRO_LONGO = 'dashboard.wishErrorTooLong'
// Dois fatos DIFERENTES, e por isso duas chaves: "você não escolheu projeto" é
// uma instrução do que fazer agora; "esse projeto não é seu (ou não está
// disponível)" é uma recusa do servidor. Enquanto dividiam a mesma chave, quem
// só tinha esquecido de escolher lia que o projeto dele estava indisponível e
// saía procurando um problema que não existia.
const ERRO_SEM_PROJETO = 'dashboard.wishErrorNoProject'
const ERRO_PROJETO = 'dashboard.wishErrorProject'
const ERRO_SESSAO = 'dashboard.wishErrorSession'
const ERRO_GITHUB = 'dashboard.wishErrorGithub'
const ERRO_REDE = 'dashboard.wishErrorNetwork'

/**
 * Teto do texto do pedido.
 *
 * O corpo de uma issue do GitHub tem limite de 65.536 caracteres. Sem este
 * teto, um texto colado acima disso era recusado com 422, virava 502 na rota e
 * chegava à tela como "tente de novo em instantes" — um conselho que NUNCA
 * funcionaria, por mais vezes que a pessoa tentasse.
 *
 * A folga até os 65.536 não é arredondamento: o corpo carrega o rodapé (quem
 * pediu, de onde veio) e o texto ainda cresce um pouco ao ter os comandos de
 * fechar issue neutralizados ("closes #42" vira "closes nº 42"), em
 * services/desejo.ts do control-plane.
 *
 * Este teto é CONVENIÊNCIA: ele poupa a viagem inútil. O teto que VALE é o do
 * servidor (LIMITE_DO_TEXTO_DO_DESEJO em services/desejo.ts do control-plane,
 * que recusa com 413) — este aqui some assim que alguém abre o inspetor, e a
 * rota HTTP não tem como confiar nele.
 */
export const LIMITE_DO_TEXTO_DO_DESEJO = 60_000

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
 * Lista os projetos do dono que ACEITAM pedido.
 *
 * A fonte é `GET /api/v1/desejos/projetos`, que devolve exatamente o que o
 * envio aceita — a mesma regra, um lugar só (services/projetos-do-desejo.ts no
 * control-plane).
 *
 * Antes a lista era deduzida da tela de setup (`/api/v1/setup/status`), que
 * filtra por dono e por missão de setup e NÃO olha se o projeto está ativo,
 * enquanto o envio exige projeto ativo. Isso dava os dois erros opostos: a tela
 * oferecia no seletor um projeto que o servidor recusava no clique ("esse
 * projeto não está disponível" para o único item que ela mesma ofereceu), e
 * escondia projeto criado por outro caminho, que o servidor teria aceitado.
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
    const res = await doFetch(`${apiBaseUrl}/api/v1/desejos/projetos`, { credentials: 'include' })
    if (!res.ok) return NAO_VERIFICADO
    const json: unknown = await res.json().catch(() => null)
    return extrairProjetos(json)
  } catch {
    return NAO_VERIFICADO
  }
}

// Anti-fachada: um corpo que não seja `{ projetos: [...] }` é resposta que não
// dá para entender — não é prova de ausência de projeto, então volta como
// não-verificado. Já um item torto DENTRO de uma lista boa é descartado
// sozinho, sem derrubar os projetos que vieram inteiros.
function extrairProjetos(json: unknown): ResultadoDosProjetos {
  if (!json || typeof json !== 'object') return NAO_VERIFICADO
  const corpo = json as { projetos?: unknown }
  if (!Array.isArray(corpo.projetos)) return NAO_VERIFICADO

  const vistos = new Set<string>()
  const projetos: ProjetoDoPainel[] = []
  for (const bruto of corpo.projetos) {
    if (!bruto || typeof bruto !== 'object') continue
    const p = bruto as Record<string, unknown>
    if (typeof p['id'] !== 'string' || typeof p['repo'] !== 'string') continue
    if (vistos.has(p['id'])) continue
    vistos.add(p['id'])
    projetos.push({ id: p['id'], repo: p['repo'] })
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
  if (texto.length > LIMITE_DO_TEXTO_DO_DESEJO) return { ok: false, chaveDoErro: ERRO_LONGO }
  if (args.projectId.trim() === '') return { ok: false, chaveDoErro: ERRO_SEM_PROJETO }

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

/**
 * Um pedido já registrado, do jeito que o aviso da tela precisa dele.
 *
 * Carrega o projeto de propósito: o aviso "registrado como #77" não é sobre a
 * tela em geral, é sobre UM pedido em UM repositório — e sem isso ele não tem
 * como se identificar nem como saber que deixou de valer.
 */
export interface DesejoRegistrado {
  numero: number
  endereco: string
  /** A qual projeto este aviso pertence. */
  projectId: string
  /** Endereço do repositório, para o aviso dizer ONDE o pedido foi registrado. */
  repo: string
}

/**
 * O aviso de sucesso ainda descreve o que está na tela?
 *
 * Ele só era limpo no começo do envio seguinte. Quem trocasse de projeto, ou
 * começasse a digitar o próximo pedido, continuava vendo "registrado como #77"
 * — sem dizer de qual projeto — e batendo o olho concluía que já tinha enviado.
 *
 * A regra é a mesma que uma pessoa usaria: o aviso vale enquanto a tela ainda
 * mostra o estado em que aquele pedido foi feito (o mesmo projeto, e a caixa de
 * texto ainda vazia). Espaço em branco não é um pedido novo.
 */
export function avisoAindaVale(
  aviso: DesejoRegistrado | null,
  tela: { projectId: string; texto: string }
): boolean {
  if (!aviso) return false
  if (aviso.projectId !== tela.projectId) return false
  return tela.texto.trim() === ''
}

// Cada recusa vira a explicação do que a PESSOA pode fazer a respeito: 401 é
// sessão vencida (entrar de novo), 404 é projeto que não é dela ou está
// desativado (escolher outro), 413 é texto acima do que cabe numa issue
// (encurtar), o resto é falha do nosso lado (tentar de novo).
//
// O 413 existe porque o teto também vale no servidor. Sem esta linha, um texto
// grande vindo de um navegador sem o `maxLength` cairia no genérico "tente de
// novo em instantes" — que é justamente o conselho impossível de cumprir.
function chaveDoStatus(status: number): string {
  if (status === 400) return ERRO_VAZIO
  if (status === 401 || status === 403) return ERRO_SESSAO
  if (status === 404) return ERRO_PROJETO
  if (status === 413) return ERRO_LONGO
  return ERRO_GITHUB
}
