// Como entender a resposta do dono à pergunta "a qual tarefa este pull request
// pertence?". Função PURA: o dono é leigo e responde como fala ("3976", "é a
// 3976", "tarefa 3976", o link da tarefa, "nenhuma", "é avulso"); exigir um
// formato rígido (`#N`) fazia a resposta ser recusada. Na dúvida NÃO adivinha:
// devolve `nao-entendida` e quem chama pergunta de novo, mantendo a pergunta
// aberta.

export type InterpretacaoDaResposta =
  /** Uma única tarefa citada. */
  | { tipo: 'tarefa'; numero: number }
  /** O dono diz que não há tarefa para este pull request. */
  | { tipo: 'nenhuma' }
  /** Mais de uma tarefa citada: a pergunta admite uma só. */
  | { tipo: 'varias'; numeros: number[] }
  /** Link de tarefa de OUTRO repositório. */
  | { tipo: 'outro-repositorio'; repositorio: string }
  | { tipo: 'nao-entendida' }

const HOSTS_DO_GITHUB = new Set(['github.com', 'www.github.com'])

/** Minúsculas, sem acento, `º` vira `o`. */
function normalizar(texto: string): string {
  return texto.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

function soPalavras(normalizado: string): string {
  return normalizado
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(
      /(^| )(por favor|obrigado|obrigada|brigado|valeu|vlw)( (por favor|obrigado|obrigada|brigado|valeu|vlw))*$/,
      ''
    )
}

/** Padrões que, sozinhos, dizem "não há tarefa". Sobre texto já passado por `soPalavras`. */
const PADROES_DE_NENHUMA: RegExp[] = [
  /^(nao|nenhum|nenhuma|nada)( (tarefa|task|issue|destas?|delas?|disso|dessas?|nenhuma))*$/,
  /^nao (tem|ha|existe|possui|tinha)( (nenhuma|nenhum|uma))?( (tarefa|task|issue|pedido))?( (nenhuma|pra isso|para isso|pra esse|para esse|pra ele|para ele))*$/,
  /^(e |eh )?(um |uma )?(pr |pedido |tarefa |entrega )?(avulso|avulsa)$/,
  /^sem (tarefa|task|issue)( nenhuma)?$/,
  /^(pode )?(seguir|segue)( (sem|com) (tarefa|task|issue|nenhuma))?$/,
]

interface LinkDeTarefa {
  repositorio: string
  numero: number
}

/** Os links de tarefa do GitHub do texto, e o texto sem nenhum link. */
function extrairLinks(texto: string): { links: LinkDeTarefa[]; resto: string } {
  const links: LinkDeTarefa[] = []
  const resto = texto.replace(/https?:\/\/[^\s<>()]+/gi, (achado) => {
    let url: URL
    try {
      url = new URL(achado.replace(/[.,;:!?]+$/, ''))
    } catch {
      return ' link-externo '
    }
    if (!HOSTS_DO_GITHUB.has(url.hostname.toLowerCase())) return ' link-externo '
    const [dono, repo, tipo, numero] = url.pathname.split('/').filter(Boolean)
    if (dono && repo && tipo === 'issues' && numero && /^\d{1,9}$/.test(numero)) {
      links.push({ repositorio: `${dono}/${repo}`, numero: Number(numero) })
    }
    return ' '
  })
  return { links, resto }
}

/**
 * Gramática FECHADA de um item de resposta (texto já normalizado e aparado):
 * [frase de apontar] [rótulo] [#]número, e nada mais. Qualquer palavra fora
 * disto torna a resposta "não entendida"; número no meio de frase nunca vale.
 */
const ITEM_DE_TAREFA =
  /^(?:(?:e|eh|seria|era)\s+)?(?:(?:a|o|da|do|de)\s+)?(?:(?:tarefa|issue|task)\s+)?(?:(?:numero|no|n)\s*[:.]?\s*)?#?(\d{1,9})$/

/** Separadores entre itens: vírgula, "e", "ou", ou espaço entre números. */
const SEPARADOR_DE_ITENS = /\s*,\s*|\s+(?:e|ou)\s+|(?<=\d)\s+(?=#?\d)/

/** Tira pontuação/emoji das pontas e cortesias finais ("por favor", "obrigado"). */
function aparar(normalizado: string): string {
  const semPontas = (t: string) => t.replace(/^[^a-z0-9#]+/, '').replace(/[^a-z0-9%]+$/, '')
  let t = semPontas(normalizado).replace(/\s+/g, ' ')
  t = semPontas(
    t.replace(
      /(^| )(por favor|obrigado|obrigada|brigado|valeu|vlw)( (por favor|obrigado|obrigada|brigado|valeu|vlw))*$/,
      ''
    )
  )
  return t
}

/** Os números da resposta INTEIRA, ou null se qualquer parte fugir da gramática. */
function numerosDaResposta(aparado: string): number[] | null {
  if (aparado === '') return null
  const numeros: number[] = []
  for (const parte of aparado.split(SEPARADOR_DE_ITENS)) {
    const m = ITEM_DE_TAREFA.exec(parte.trim())
    if (!m || m[1] === undefined) return null
    const numero = Number(m[1])
    if (numero <= 0) return null
    if (!numeros.includes(numero)) numeros.push(numero)
  }
  return numeros
}

export function interpretarRespostaDeVinculo(
  texto: string,
  repositorio: string
): InterpretacaoDaResposta {
  const { links, resto } = extrairLinks(texto)

  const alheio = links.find((l) => l.repositorio.toLowerCase() !== repositorio.toLowerCase())
  if (alheio) return { tipo: 'outro-repositorio', repositorio: alheio.repositorio }

  const normalizado = normalizar(resto)

  let numeros: number[] | null
  if (links.length > 0) {
    // Link do próprio repositório vale só quando é a resposta inteira.
    if (aparar(normalizado) !== '') return { tipo: 'nao-entendida' }
    numeros = [...new Set(links.map((l) => l.numero))]
  } else {
    numeros = numerosDaResposta(aparar(normalizado))
  }

  if (numeros && numeros.length > 0) {
    const [unico, ...outros] = numeros
    if (unico !== undefined && outros.length === 0) return { tipo: 'tarefa', numero: unico }
    return { tipo: 'varias', numeros }
  }

  if (PADROES_DE_NENHUMA.some((p) => p.test(soPalavras(normalizado)))) return { tipo: 'nenhuma' }
  return { tipo: 'nao-entendida' }
}
