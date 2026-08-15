/**
 * Transforma o pedido em texto livre do dono na issue oficial de desejo.
 *
 * A issue É o registro oficial — a tela e o mensageiro são só portas. Manter um
 * único formato aqui garante que o analista receba sempre a mesma coisa,
 * independentemente de por onde o pedido entrou.
 */

/** Etiqueta que marca a issue como desejo. Igual à de routes/github-webhook.ts. */
export const ETIQUETA_DE_DESEJO = 'wishlist'

const LIMITE_DO_TITULO = 72

export interface DesejoMontado {
  titulo: string
  corpo: string
  etiquetas: string[]
}

/**
 * Neutraliza as palavras que o GitHub interpreta como "fechar a issue tal".
 * O texto do dono é conteúdo, não comando: sem isto, um pedido que cite
 * "closes #42" fecharia a issue 42 de outra pessoa ao ser publicado.
 */
function neutralizarComandos(texto: string): string {
  return texto.replace(/\b(closes|fixes|resolves)\s+#(\d+)/gi, '$1 nº $2')
}

function primeiraFrase(texto: string): string {
  const corte = texto.search(/[.!?](\s|$)/)
  return corte === -1 ? texto : texto.slice(0, corte)
}

function encurtar(frase: string): string {
  if (frase.length <= LIMITE_DO_TITULO) return frase
  const cortado = frase.slice(0, LIMITE_DO_TITULO - 1)
  const ultimoEspaco = cortado.lastIndexOf(' ')
  const base = ultimoEspaco > LIMITE_DO_TITULO / 2 ? cortado.slice(0, ultimoEspaco) : cortado
  return `${base.trimEnd()}…`
}

export function montarDesejo(args: { texto: string; autor: string }): DesejoMontado {
  const texto = args.texto.trim()
  if (texto.length === 0)
    throw new Error('Pedido vazio: não dá para registrar um desejo sem texto.')

  const limpo = neutralizarComandos(texto)
  const titulo = encurtar(primeiraFrase(limpo).trim())

  const corpo = [
    limpo,
    '',
    '---',
    `Pedido por: ${args.autor}`,
    'Registrado pelo GitOrch a partir de um pedido em linguagem natural.',
  ].join('\n')

  return { titulo, corpo, etiquetas: [ETIQUETA_DE_DESEJO] }
}
