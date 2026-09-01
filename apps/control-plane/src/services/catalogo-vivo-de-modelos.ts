/**
 * O nome do modelo tem que vir do CATÁLOGO VIVO, não de um literal que envelhece.
 *
 * O QUE ACONTECEU (31/08/2026): `MODEL_FLASH` valia `'Gemini 3.5 Flash (Medium)'`,
 * escrito no código. Às 16:12 desse dia o catálogo coletado ainda listava a
 * geração 3.5; às 23:00 o provedor a tinha removido. A partir das 16:57, 100%
 * das missões do Antigravity morreram com `invalid model selection` — 24
 * tentativas numa janela de 9h48, cada uma pagando um `podman run` inteiro.
 *
 * E O DEFEITO NÃO ERA A COLETA ESTAR ATRASADA — ela estava em dia. O produto
 * tem DOIS TRILHOS que nunca se encontravam: a coleta grava o catálogo em
 * `engine_connections.models` (só para exibir na tela), e a escolha do modelo
 * da missão vem de um literal no código. Trocar a string consertaria hoje e
 * quebraria de novo na próxima remoção do provedor. O conserto é ligar os dois.
 *
 * FAIL-OPEN por decisão, não por descuido: catálogo vazio quer dizer "não sei",
 * NUNCA "o modelo não existe". Uma guarda que desligasse o motor por não ter
 * lista derrubaria a esteira toda vez que a leitura do banco falhasse — trocar
 * um desperdício por uma paralisação, exatamente o que `filtrarCadeia` já
 * recusa fazer em motor-em-pausa.ts.
 */

/**
 * `agy models` imprime `slug<TAB>Nome de Exibição` — conferido nesta VM com
 * `agy models | cat -A`. O `--model` aceita o NOME DE EXIBIÇÃO, não o slug:
 *
 *   $ agy --model "Gemini 3.5 Flash (Medium)" -p "say ok"
 *   Error: invalid model selection ... Available models:
 *     Gemini 3.7 Flash (High)
 *     ...
 *
 * O coletor antigo só fazia `split('\n')` + `trim()`, então o banco guardava a
 * string COLADA (`'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)'`) — que
 * não serve como valor de `--model` nem como item de comparação. O teste não
 * pegava porque o fake nunca teve TAB.
 *
 * Linha sem TAB passa inteira: Claude e Codex já entregam só o nome.
 */
export function nomeDeExibicaoDoModelo(linha: string): string {
  const tab = linha.indexOf('\t')
  return (tab === -1 ? linha : linha.slice(tab + 1)).trim()
}

/** Ruído que o CLI imprime junto da lista e que não é modelo nenhum. */
const RUIDO_DO_CLI = /^(fetching|loading|available models)/i

export function ehLinhaDeModelo(linha: string): boolean {
  return linha.trim().length > 0 && !RUIDO_DO_CLI.test(linha.trim())
}

/**
 * Um nome como `Gemini 3.7 Flash (Medium)` decomposto no que o produto de fato
 * escolheu: a FAMÍLIA (`gemini flash`), o ESFORÇO (`medium`) e a GERAÇÃO (3.7).
 * A geração é a única parte que o provedor troca embaixo do produto.
 */
interface PecasDoModelo {
  familia: string
  esforco: string
  geracao: number
}

const FORMATO = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*\(([^()]+)\)\s*$/

function pecasDoModelo(nome: string): PecasDoModelo | null {
  const m = FORMATO.exec(nome.trim())
  if (!m) return null
  const [, marca, geracao, linha, esforco] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ]
  return {
    familia: `${marca.toLowerCase()} ${linha.toLowerCase()}`,
    esforco: esforco.toLowerCase(),
    geracao: Number(geracao),
  }
}

export interface EscolhaDeModelo {
  /** O modelo que a missão deve usar. */
  modelo: string
  /** true só quando a guarda de fato substituiu o modelo pedido. */
  trocado: boolean
  /**
   * O que dizer no log quando algo não bate. `undefined` quando está tudo certo
   * — a guarda não fala à toa.
   */
  aviso?: string
}

/**
 * Confere o modelo pedido contra o catálogo vivo e, quando ele não existe mais,
 * substitui pelo equivalente — mesma FAMÍLIA e mesmo ESFORÇO, geração mais nova.
 *
 * Por que família E esforço, e não "o mais novo da lista": o produto escolheu
 * Flash+Medium de propósito para ra/sm/qa (Pro/Low fica só para o PO decidir).
 * Um substituto que troca o esforço muda o comportamento do agente pelas costas.
 *
 * Por que a geração MAIS NOVA: em 31/08 existiam 3.6 e 3.7 Flash (Medium) — dois
 * candidatos exatos. O provedor mantém duas gerações e derruba a mais velha sem
 * aviso (a 3.5 morreu em menos de 7 horas, no meio do dia). Escolher a mais
 * velha é escolher a próxima a cair.
 *
 * Quando não há equivalente, NÃO inventa substituto de outra família: mantém o
 * pedido e DIZ. Repetir a falha em silêncio é o que trouxe o produto até aqui.
 */
export function escolherModeloVivo(args: {
  desejado: string
  catalogo: readonly string[]
}): EscolhaDeModelo {
  const desejado = args.desejado
  const vivos = args.catalogo.filter(ehLinhaDeModelo).map(nomeDeExibicaoDoModelo)

  // FAIL-OPEN: sem catálogo não há o que conferir. Segue com o pedido.
  if (vivos.length === 0) return { modelo: desejado, trocado: false }

  if (vivos.some((m) => m === desejado)) return { modelo: desejado, trocado: false }

  const alvo = pecasDoModelo(desejado)
  const candidato = alvo
    ? vivos
        .map((nome) => ({ nome, pecas: pecasDoModelo(nome) }))
        .filter(
          (c): c is { nome: string; pecas: PecasDoModelo } =>
            c.pecas !== null && c.pecas.familia === alvo.familia && c.pecas.esforco === alvo.esforco
        )
        .sort((a, b) => b.pecas.geracao - a.pecas.geracao)[0]
    : undefined

  if (!candidato) {
    return {
      modelo: desejado,
      trocado: false,
      aviso:
        `o modelo "${desejado}" não está no catálogo vivo deste motor ` +
        `(${vivos.length} disponíveis: ${vivos.join(', ')}) e não há equivalente de mesma ` +
        `família e esforço para substituir — a missão vai tentar assim mesmo e provavelmente falhar`,
    }
  }

  return {
    modelo: candidato.nome,
    trocado: true,
    aviso:
      `o modelo "${desejado}" saiu do catálogo do provedor; usando "${candidato.nome}" ` +
      `(mesma família e mesmo esforço, geração mais nova disponível)`,
  }
}
