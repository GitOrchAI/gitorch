// D7 (parte A) do desenho aprovado em 30/08 ("A lógica da leva 2"): o nível
// "Sugerir" descreve a si mesmo assim — "propõe fechar, juntar, quebrar e
// ESPERA SEU AVAL EM LOTE". O que alimenta o lote já existe
// (diagnostico-de-issues.ts, PR #437); o que faltava é ESTE arquivo — juntar
// os achados de um projeto numa lista única, com o motivo de cada um, e
// resolver UM aval sobre o lote inteiro (tudo, nada, ou item a item).
//
// Este arquivo é LEITURA + REGRA PURA, sem rede — a mesma garantia estrutural
// de diagnostico-de-issues.ts. A ESCRITA de verdade (fechar issue no GitHub)
// mora em aplicar-lote-de-sugestoes.ts, que consome a decisão daqui e é o
// único lugar com uma chamada de rede.
//
// POR QUE SÓ "fechar" E "juntar" TÊM AÇÃO DE ESCRITA (e não "quebrar"): o
// desenho fala em "fechar, juntar, quebrar" como capacidade do nível, não
// como contrato de que toda categoria vira uma dessas três. As cinco
// categorias de diagnostico-de-issues.ts são { já_resolvido, repetido,
// parado, risco, vago } — só as duas primeiras têm uma ação de escrita
// CONCRETA e de baixo risco (fechar / fechar-como-duplicata). Não existe,
// hoje, nenhuma lógica que decida COMO quebrar uma issue em pedaços menores —
// inventar essa ação aqui seria fabricar uma escrita sem base, o mesmo defeito
// que a Lei da Verdade proíbe. "parado", "risco" e "vago" viram SINAL para o
// dono ler no lote (o "risco" em especial pede o olho dele, não uma escrita
// automática) — nunca uma ação de escrita silenciosa.
import type {
  AchadoDeDiagnostico,
  CategoriaDeDiagnostico,
  ResultadoDoDiagnostico,
} from './diagnostico-de-issues.js'

export type { AchadoDeDiagnostico, CategoriaDeDiagnostico, ResultadoDoDiagnostico }

/** A ação que o lote propõe para cada categoria. Ver o comentário do topo. */
export type AcaoDeLote = 'fechar' | 'juntar' | 'sinalizar'

export const ACAO_DA_CATEGORIA: Record<CategoriaDeDiagnostico, AcaoDeLote> = {
  ja_resolvido: 'fechar',
  repetido: 'juntar',
  parado: 'sinalizar',
  risco: 'sinalizar',
  vago: 'sinalizar',
}

export interface ItemDoLote {
  issue: number
  categoria: CategoriaDeDiagnostico
  acao: AcaoDeLote
  /** POR QUE foi sugerido — cada item mostra o motivo, para o dono julgar. */
  motivo: string
  evidencia?: string | undefined
  /**
   * Só presente quando `acao === 'juntar'` E a evidência de `repetido`
   * conseguiu extrair o número da issue original ("issue #N"). Se o formato
   * mudar e a extração falhar, fica `undefined` — nunca um número inventado.
   */
  duplicadaDe?: number | undefined
}

export interface LoteDeSugestoes {
  /** Os itens que couberam no teto — o lote de verdade que chega ao dono. */
  itens: ItemDoLote[]
  /** Quantos achados existiam ANTES do teto — para o dono saber o tamanho real. */
  totalDeAchados: number
  /**
   * Quantos ficaram de fora do teto. NUNCA fica em silêncio (a lição da
   * L3-T23): quem lê este número sabe que "aprovar tudo" não é "aprovar
   * tudo que existe", é "aprovar tudo o que CHEGOU".
   */
  foraDoTeto: number
}

/** Sem ordem no desenho para um número — 25 é grande o bastante para um lote
 *  útil e pequeno o bastante para não cansar quem avalia um item por vez. */
export const TETO_PADRAO_DO_LOTE = 25

const REGEX_ISSUE_ORIGINAL = /#(\d+)/

function extrairDuplicadaDe(evidencia: string | undefined): number | undefined {
  if (!evidencia) return undefined
  const m = evidencia.match(REGEX_ISSUE_ORIGINAL)
  if (!m || !m[1]) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

function achadoParaItem(achado: AchadoDeDiagnostico): ItemDoLote {
  const acao = ACAO_DA_CATEGORIA[achado.categoria]
  return {
    issue: achado.issue,
    categoria: achado.categoria,
    acao,
    motivo: achado.motivo,
    evidencia: achado.evidencia,
    duplicadaDe: acao === 'juntar' ? extrairDuplicadaDe(achado.evidencia) : undefined,
  }
}

/**
 * Junta os achados de um projeto numa lista única, com o motivo de cada um —
 * a caixa "SUGERIR" do desenho. Corta no teto e sempre diz quantos ficaram de
 * fora; nunca lança (achados vazios viram lote vazio, não erro).
 */
export function montarLoteDeSugestoes(
  resultado: ResultadoDoDiagnostico,
  opcoes: { teto?: number } = {}
): LoteDeSugestoes {
  const teto = opcoes.teto ?? TETO_PADRAO_DO_LOTE
  const todos = resultado.achados.map(achadoParaItem)
  const itens = todos.slice(0, teto)
  return {
    itens,
    totalDeAchados: todos.length,
    foraDoTeto: Math.max(0, todos.length - teto),
  }
}

export type DecisaoDoItem = 'aprovado' | 'recusado'

export type ModoDeAval = 'aprovar_tudo' | 'recusar_tudo' | 'por_item'

export interface AvalDoLote {
  modo: ModoDeAval
  /**
   * Só lido quando `modo === 'por_item'`. Issue AUSENTE do mapa vem
   * `'recusado'` — falha fechada, nunca aprovação por omissão (a mesma lição
   * do "default vazio que mente").
   */
  porItem?: Record<number, DecisaoDoItem>
}

export interface ItemComDecisao extends ItemDoLote {
  decisao: DecisaoDoItem
}

/**
 * Resolve UM aval sobre o lote inteiro: aprovar tudo, recusar tudo, ou
 * escolher item a item DENTRO do lote. Regra pura — não escreve nada; quem
 * aplica de verdade é `aplicarLoteDeSugestoes` (aplicar-lote-de-sugestoes.ts).
 */
export function resolverAvalDoLote(lote: LoteDeSugestoes, aval: AvalDoLote): ItemComDecisao[] {
  return lote.itens.map((item) => {
    const decisao: DecisaoDoItem =
      aval.modo === 'aprovar_tudo'
        ? 'aprovado'
        : aval.modo === 'recusar_tudo'
          ? 'recusado'
          : (aval.porItem?.[item.issue] ?? 'recusado')
    return { ...item, decisao }
  })
}
