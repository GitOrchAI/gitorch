// Texto que vem de fora (título e corpo de issue ou PR, nome de pacote, licença,
// caminho, mensagem de erro de rede, resumo do motor) e vai para o banco, o
// painel, o Cortex ou o GitHub passa por aqui antes.
//
// Dois defeitos que `String.prototype.slice` não evita:
//  - Cortar em unidades UTF-16 pode partir um par substituto (emoji, caractere
//    fora do plano básico) ao meio. O `JSON.stringify` escreve a metade como
//    `\ud83d` e o jsonb do Postgres recusa a gravação inteira, de novo a cada
//    passada, enquanto o texto existir.
//  - Um substituto solto que já veio no texto tem o mesmo efeito.
// Aqui o corte é por ponto de código e o substituto solto vira U+FFFD.
//
// E uma mensagem de erro de rede pode carregar o cabeçalho `Authorization` ou o
// próprio token: `mascararCredenciais` tira isso antes de o texto ir adiante.

const SUBSTITUTO_SOLTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const SUBSTITUTO_SOLTO_TESTE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Troca cada substituto solto (metade de um par sem a outra) por U+FFFD. */
export function limparSurrogates(texto: string): string {
  return SUBSTITUTO_SOLTO_TESTE.test(texto) ? texto.replace(SUBSTITUTO_SOLTO, '�') : texto
}

/** Percorre textos, chaves, listas e objetos simples; o resto passa como está. */
export function limparSurrogatesEmJson<T>(valor: T): T {
  if (typeof valor === 'string') return limparSurrogates(valor) as T
  if (Array.isArray(valor)) return valor.map((item) => limparSurrogatesEmJson(item)) as T
  if (valor !== null && typeof valor === 'object') {
    const prototipo = Object.getPrototypeOf(valor) as unknown
    if (prototipo !== Object.prototype && prototipo !== null) return valor
    const saida: Record<string, unknown> = {}
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      saida[limparSurrogates(chave)] = limparSurrogatesEmJson(item)
    }
    return saida as T
  }
  return valor
}

function contarPontos(texto: string): number {
  let total = 0
  for (const _ of texto) total += 1
  return total
}

export interface OpcoesDoCorte {
  /** Acrescentado ao texto cortado; conta dentro do máximo. */
  sufixo?: string
  /** Tira o espaço que sobrou antes do sufixo. */
  aparar?: boolean
}

/**
 * Corta em no máximo `maximo` pontos de código (o sufixo incluído), nunca no
 * meio de um par substituto, e devolve o texto já sem substituto solto.
 */
export function cortarPorPontoDeCodigo(
  texto: string,
  maximo: number,
  opcoes: OpcoesDoCorte = {}
): string {
  const limpo = limparSurrogates(texto)
  if (limpo.length <= maximo || contarPontos(limpo) <= maximo) return limpo
  const sufixo = opcoes.sufixo ?? ''
  const manter = Math.max(0, maximo - contarPontos(sufixo))
  let fim = 0
  let pontos = 0
  while (pontos < manter && fim < limpo.length) {
    fim += (limpo.codePointAt(fim) ?? 0) > 0xffff ? 2 : 1
    pontos += 1
  }
  const inicio = limpo.slice(0, fim)
  return `${opcoes.aparar ? inicio.trimEnd() : inicio}${sufixo}`
}

const SEGREDO_CURTO_DEMAIS = 6

const PADROES_DE_CREDENCIAL: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer x`, `"authorization":"token x"`, `proxy-authorization=Basic x`
  [
    /\b((?:proxy-)?authorization\b["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;)}\]]+/gi,
    '$1***',
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***'],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, '***'],
  // usuário:senha embutidos na URL
  [/(\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@'],
]

const VALOR_ILEGIVEL = '[valor ilegível]'

/** O valor como texto, sem nunca lançar: `throw` aceita qualquer coisa, até o que não vira texto. */
function comoTexto(valor: unknown): string {
  try {
    return String(valor)
  } catch {
    return VALOR_ILEGIVEL
  }
}

/**
 * A mensagem de um valor lançado. `throw` aceita qualquer valor (texto, objeto,
 * `undefined`), então `(err as Error).message` pode ser `undefined` ou até
 * lançar de novo: aqui a leitura nunca falha.
 */
export function mensagemDoErro(erro: unknown): string {
  try {
    if (typeof erro === 'object' && erro !== null) {
      const mensagem = (erro as { message?: unknown }).message
      if (typeof mensagem === 'string') return mensagem
    }
  } catch {
    return VALOR_ILEGIVEL
  }
  return comoTexto(erro)
}

/**
 * Tira o que parece credencial: os segredos que a etapa conhece (literais) e os
 * padrões de cabeçalho e de token do GitHub, mesmo os que ela não conhece.
 * Aceita qualquer entrada: é usada no caminho de erro, que não pode lançar.
 */
export function mascararCredenciais(
  texto: string,
  segredos: readonly string[] | null = []
): string {
  let saida = typeof texto === 'string' ? texto : comoTexto(texto)
  for (const segredo of segredos ?? []) {
    if (typeof segredo === 'string' && segredo.length >= SEGREDO_CURTO_DEMAIS) {
      saida = saida.split(segredo).join('***')
    }
  }
  for (const [padrao, troca] of PADROES_DE_CREDENCIAL) saida = saida.replace(padrao, troca)
  return saida
}

/** O erro como texto, sem credencial e com no máximo `maximo` pontos de código. */
export function resumirErro(
  erro: unknown,
  maximo: number,
  segredos: readonly string[] = []
): string {
  return cortarPorPontoDeCodigo(mascararCredenciais(comoTexto(erro), segredos), maximo)
}
