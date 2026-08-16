/**
 * Guarda da porta de saída de rede.
 *
 * Todo endereço que o produto visita nasce fora dele — vem do GitHub
 * (`environment_url` de uma publicação) ou da configuração do cliente. Sem
 * esta porta, um endereço apontando para dentro da rede transforma o produto
 * em ponte para o que ele alcança e o cliente não (SSRF). A guarda mora aqui
 * e não nos chamadores: chamador esquece, porta não. As Tarefas 13 e 14 só
 * alcançam a rede por `buscarComGuarda`.
 */

/** Only http/https carry meaning for "endereço que foi ao ar" — todo o resto é recusado. */
const ESQUEMAS_PERMITIDOS = new Set(['http:', 'https:'])

/**
 * Nomes que sempre apontam para a própria máquina ou para dentro da rede.
 * Comparados por RÓTULO exato (cada pedaço entre pontos), nunca por
 * substring/prefixo do texto inteiro — foi assim que este produto deixou
 * passar `api.github.com.servidor-alheio` antes (incidente real de SSRF).
 * Rótulo exato pega tanto "localhost" sozinho quanto "localhost.atacante.com"
 * (o rótulo da esquerda é, literalmente, "localhost"), sem confundir
 * "notlocalhost.com" (cujo rótulo é "notlocalhost", uma palavra diferente).
 */
const ROTULOS_INTERNOS = new Set(['localhost', 'ip6-localhost', 'ip6-loopback'])

/** Sufixos de domínio reservados para rede interna (não roteáveis na internet pública). */
const SUFIXOS_INTERNOS = ['.internal', '.local']

function ehIpv4Interno(host: string): boolean {
  const partes = host.split('.')
  if (partes.length !== 4) return false
  const numeros = partes.map((p) => Number(p))
  if (numeros.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = numeros as [number, number, number, number]
  if (a === 0) return true // "esta rede" (RFC 5735)
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10, NAT de operadora (RFC 6598) — nunca roteável na internet pública
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24, atribuições de protocolo IETF (RFC 6890)
  if (a === 192 && b === 0 && c === 2) return true // 192.0.2.0/24, TEST-NET-1 — só existe em documentação (RFC 5737)
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15, faixa de benchmarking (RFC 2544)
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24, TEST-NET-2 — só existe em documentação (RFC 5737)
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24, TEST-NET-3 — só existe em documentação (RFC 5737)
  if (a === 169 && b === 254) return true // link-local, inclui o metadados de nuvem 169.254.169.254
  if (a >= 224) return true // multicast (224-239) e reservado (240-255), inclui a difusão limitada 255.255.255.255
  return false
}

/**
 * Expande um host IPv6 canônico (já normalizado e comprimido pelo `URL`,
 * ex.: "::1", "fe80::1", "::ffff:7f00:1") nos seus 8 grupos de 16 bits.
 * `null` quando o texto não é um IPv6 válido nessa forma.
 */
function expandirIpv6(host: string): number[] | null {
  if (!host.includes(':')) return null

  const duploIndex = host.indexOf('::')
  let ladoEsquerdo: string[]
  let ladoDireito: string[]
  if (duploIndex === -1) {
    ladoEsquerdo = host.split(':')
    ladoDireito = []
  } else {
    if (host.indexOf('::', duploIndex + 1) !== -1) return null // mais de um "::" não é válido
    const antes = host.slice(0, duploIndex)
    const depois = host.slice(duploIndex + 2)
    ladoEsquerdo = antes ? antes.split(':') : []
    ladoDireito = depois ? depois.split(':') : []
  }

  const faltam = 8 - ladoEsquerdo.length - ladoDireito.length
  if (faltam < 0 || (duploIndex === -1 && faltam !== 0)) return null

  const grupos = [...ladoEsquerdo, ...new Array(faltam).fill('0'), ...ladoDireito]
  if (grupos.length !== 8) return null

  const numeros = grupos.map((g) => (g === '' ? NaN : Number.parseInt(g, 16)))
  if (numeros.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return numeros
}

/**
 * Checa a faixa interna de um IPv6 pelos bits do primeiro grupo — não pelo
 * texto. `fe80::/10` cobre de `fe80::` a `febf::`; um `startsWith('fe80:')`
 * pega só o primeiro caso e deixa passar o resto da faixa (bug real fechado
 * aqui, não previsto no rascunho original do brief).
 */
function ehIpv6Interno(host: string): boolean {
  const grupos = expandirIpv6(host)
  if (!grupos) return false
  const [g0, g1, g2, g3, g4, g5, g6, g7] = grupos as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]

  if (grupos.every((g) => g === 0)) return true // :: (não especificado)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)
    return true // ::1 (loopback)
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 (link-local)
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 (rede local única)
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 (multicast)
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10, site-local depreciado (RFC 3879) — nunca reatribuído, segue não roteável apesar do desuso
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true // 100::/64, bloco "somente descarte" (RFC 6666)
  if (g0 === 0x2001 && g1 === 0x0db8) return true // 2001:db8::/32, reservado para documentação (RFC 3849)
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true // 3fff::/20, reservado para documentação (RFC 9637)
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0) return true // 2001:2::/48, faixa de benchmarking (RFC 5180)

  // IPv4 mapeado (::ffff:a.b.c.d) ou compatível/depreciado (::a.b.c.d): os
  // últimos 32 bits carregam um IPv4 de verdade — julga pela regra de IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`
    return ehIpv4Interno(ipv4)
  }

  return false
}

export function enderecoPermitido(url: string): { permitido: boolean; motivo: string } {
  let alvo: URL
  try {
    alvo = new URL(url)
  } catch {
    return { permitido: false, motivo: 'não é um endereço válido' }
  }

  if (!ESQUEMAS_PERMITIDOS.has(alvo.protocol)) {
    return { permitido: false, motivo: `esquema não permitido: ${alvo.protocol}` }
  }

  // Uma credencial já viajou, uma vez, para um endereço que não devia — é por
  // isso que esta guarda existe. Hoje quem recusa `usuário:senha@host` é o
  // fetch do runtime, não este código: é uma garantia emprestada, não nossa.
  // Recusa aqui, na origem, antes de qualquer checagem de host.
  if (alvo.username !== '' || alvo.password !== '') {
    return { permitido: false, motivo: 'endereço com credencial embutida (usuário/senha)' }
  }

  // `URL` já normaliza caixa e desvios de codificação de IPv4 (decimal, octal,
  // hexadecimal, forma curta) para a forma canônica — a checagem abaixo já
  // recebe o host pronto. O strip de colchetes é defensivo para IPv6.
  const host = alvo.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host.split('.').some((rotulo) => ROTULOS_INTERNOS.has(rotulo))) {
    return { permitido: false, motivo: 'aponta para a própria máquina ou nome de rede interna' }
  }

  if (ehIpv6Interno(host)) {
    return { permitido: false, motivo: 'endereço IPv6 de rede interna' }
  }

  if (SUFIXOS_INTERNOS.some((sufixo) => host.endsWith(sufixo))) {
    return { permitido: false, motivo: 'nome de rede interna' }
  }

  if (ehIpv4Interno(host)) {
    return { permitido: false, motivo: 'endereço IPv4 de rede interna' }
  }

  return { permitido: true, motivo: 'endereço público' }
}

/** Tamanho máximo do corpo lido — o resto da resposta é descartado, nunca acumulado. */
const TAMANHO_MAXIMO_CORPO_BYTES = 256 * 1024
/** Tempo limite padrão de uma tentativa (inicial ou um desvio) antes de desistir. */
const TIMEOUT_PADRAO_MS = 15_000
/** Quantos desvios (3xx) a guarda segue antes de desistir — cada um revalidado do zero. */
const MAX_DESVIOS_SEGUIDOS = 3

async function lerCorpoComTeto(resposta: Response, maximoBytes: number): Promise<string> {
  if (!resposta.body) return ''

  const leitor = resposta.body.getReader()
  const decodificador = new TextDecoder()
  let lidos = 0
  let corpo = ''

  while (true) {
    const { done, value } = await leitor.read()
    if (done) break

    const restante = maximoBytes - lidos
    if (restante <= 0) {
      await leitor.cancel('teto de tamanho do corpo atingido')
      break
    }

    if (value.byteLength > restante) {
      corpo += decodificador.decode(value.subarray(0, restante))
      lidos += restante
      await leitor.cancel('teto de tamanho do corpo atingido')
      break
    }

    corpo += decodificador.decode(value, { stream: true })
    lidos += value.byteLength
  }

  return corpo
}

/**
 * Busca um endereço só depois de passar pela guarda — nunca chama `fetch`
 * direto. Revalida CADA desvio (3xx) do zero, porque o primeiro endereço ser
 * público não prova nada sobre para onde o desvio leva. Não aceita cabeçalho
 * nenhum na assinatura: estruturalmente não há como uma credencial viajar
 * por aqui.
 */
export async function buscarComGuarda(
  url: string,
  opcoes?: { timeoutMs?: number }
): Promise<{ status: number; corpo: string }> {
  const timeoutMs = opcoes?.timeoutMs ?? TIMEOUT_PADRAO_MS
  let alvo = url

  for (let desvio = 0; desvio <= MAX_DESVIOS_SEGUIDOS; desvio++) {
    const veredito = enderecoPermitido(alvo)
    if (!veredito.permitido) {
      throw new Error(`endereço recusado pela guarda de rede: ${veredito.motivo}`)
    }

    const controlador = new AbortController()
    const gatilho = setTimeout(() => controlador.abort(), timeoutMs)
    let resposta: Response
    try {
      resposta = await fetch(alvo, {
        method: 'GET',
        redirect: 'manual',
        signal: controlador.signal,
      })
    } catch (erro) {
      if (controlador.signal.aborted) {
        throw new Error(`tempo limite de ${timeoutMs}ms excedido buscando o endereço`)
      }
      throw erro
    } finally {
      clearTimeout(gatilho)
    }

    if (resposta.status >= 300 && resposta.status < 400) {
      const local = resposta.headers.get('location')
      if (!local) {
        throw new Error('desvio (3xx) sem cabeçalho de destino')
      }
      alvo = new URL(local, alvo).toString()
      continue
    }

    const corpo = await lerCorpoComTeto(resposta, TAMANHO_MAXIMO_CORPO_BYTES)
    return { status: resposta.status, corpo }
  }

  throw new Error(`cadeia de desvios excedeu o limite de ${MAX_DESVIOS_SEGUIDOS}`)
}
