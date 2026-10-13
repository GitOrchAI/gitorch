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

/** Acima disto não é número de tarefa (evita estouro e telefone colado). */
const MAX_DIGITOS = 9

const ANO_MIN = 1990
const ANO_MAX = 2100

const HOSTS_DO_GITHUB = new Set(['github.com', 'www.github.com'])

/** Minúsculas, sem acento, `º` vira `o`. */
function normalizar(texto: string): string {
  return texto.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

function soPalavras(normalizado: string): string {
  return normalizado
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/( (por favor|obrigado|obrigada|brigado|valeu|vlw))+$/, '')
}

/** Padrões que, sozinhos, dizem "não há tarefa". Sobre texto já passado por `soPalavras`. */
const PADROES_DE_NENHUMA: RegExp[] = [
  /^(nao|nenhum|nenhuma|nada)( (tarefa|task|issue|destas?|delas?|disso|dessas?|nenhuma))*$/,
  /^nao (tem|ha|existe|possui|tinha)( (nenhuma|nenhum|uma))?( (tarefa|task|issue|pedido))?( (nenhuma|pra isso|para isso|pra esse|para esse|pra ele|para ele))*$/,
  /^(e |eh )?(um |uma )?(pr |pedido |tarefa |entrega )?(avulso|avulsa)$/,
  /^sem (tarefa|task|issue)( nenhuma)?$/,
  /^(pode )?(seguir|segue)( (sem|com) (tarefa|task|issue|nenhuma))?$/,
]

const PALAVRAS_DE_NEGACAO = /\b(nao|nenhum|nenhuma|sem|avulso|avulsa)\b/

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
      return ' '
    }
    if (!HOSTS_DO_GITHUB.has(url.hostname.toLowerCase())) return ' '
    const [dono, repo, tipo, numero] = url.pathname.split('/').filter(Boolean)
    if (dono && repo && tipo === 'issues' && numero && /^\d{1,9}$/.test(numero)) {
      links.push({ repositorio: `${dono}/${repo}`, numero: Number(numero) })
    }
    return ' '
  })
  return { links, resto }
}

const PREFIXO_EXPLICITO = /(tarefa|issue|task|numero|no|n)\s*[:.]?\s*$/

const MOEDA_ANTES = /(r\$|us\$|\$)\s*$/
const UNIDADE_DEPOIS =
  /^\s*(reais|real|dolares?|usd|brl|k\b|mil\b|h\b|hs\b|hrs?\b|horas?\b|min\b|minutos?\b|seg\b|segundos?\b|dias?\b|semanas?\b|mes(es)?\b|anos?\b|%|por cento|x\b)/
const PREFIXO_DE_ANO = /(^|\s)(em|de|desde|ate|ano|ano de)\s+$/

/** Os números do texto que podem ser tarefa, na ordem em que aparecem, sem repetição. */
function numerosDeTarefa(normalizado: string): number[] {
  const achados: number[] = []
  for (const m of normalizado.matchAll(/(?<![a-z0-9])(#?)(\d+)(?![a-z0-9])/g)) {
    const [, cerquilha, digitos] = m
    if (digitos === undefined || digitos.length > MAX_DIGITOS) continue
    const numero = Number(digitos)
    if (numero <= 0) continue
    const inicio = m.index ?? 0
    const antes = normalizado.slice(0, inicio)
    const depois = normalizado.slice(inicio + m[0].length)

    const explicito = cerquilha === '#' || PREFIXO_EXPLICITO.test(antes)
    if (!explicito) {
      // Parte de decimal, milhar, horário ou data: o vizinho imediato é separador + dígito.
      if (/\d[.,:/]$/.test(antes) || /^[.,:/]\d/.test(depois)) continue
      if (MOEDA_ANTES.test(antes) || UNIDADE_DEPOIS.test(depois)) continue
      if (numero >= ANO_MIN && numero <= ANO_MAX && PREFIXO_DE_ANO.test(antes)) continue
    }
    if (!achados.includes(numero)) achados.push(numero)
  }
  return achados
}

export function interpretarRespostaDeVinculo(
  texto: string,
  repositorio: string
): InterpretacaoDaResposta {
  const { links, resto } = extrairLinks(texto)

  const alheio = links.find((l) => l.repositorio.toLowerCase() !== repositorio.toLowerCase())
  if (alheio) return { tipo: 'outro-repositorio', repositorio: alheio.repositorio }

  const normalizado = normalizar(resto)
  const numeros = [...links.map((l) => l.numero)]
  for (const n of numerosDeTarefa(normalizado)) if (!numeros.includes(n)) numeros.push(n)

  const palavras = soPalavras(normalizado)

  if (numeros.length > 0) {
    // "não é a 3976" e "sem tarefa, 3976": a negação muda o sentido do número.
    if (PALAVRAS_DE_NEGACAO.test(palavras)) return { tipo: 'nao-entendida' }
    const [unico, ...outros] = numeros
    if (unico !== undefined && outros.length === 0) return { tipo: 'tarefa', numero: unico }
    return { tipo: 'varias', numeros }
  }

  if (PADROES_DE_NENHUMA.some((p) => p.test(palavras))) return { tipo: 'nenhuma' }
  return { tipo: 'nao-entendida' }
}
