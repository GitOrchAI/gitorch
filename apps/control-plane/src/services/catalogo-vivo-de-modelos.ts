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

/**
 * A MARCA do modelo — a primeira palavra do nome (`gemini`, `claude`, `gpt`).
 *
 * Serve para uma pergunta só, e ela é decisiva: este nome é modelo DESTE motor?
 * Medido ao vivo em 01/09/2026, com a credencial real do dono:
 *
 *   $ claude --model "Gemini 3.7 Flash (Medium)" -p "say ok"
 *   "Gemini 3.7 Flash (Medium)" is not a model this version of Claude Code
 *   recognizes ... There's an issue with the selected model.
 *
 * E o resolvedor entrega esse nome ao degrau do claude: rodando
 * `resolveRuntimeChain('ra', null, defaults, ['antigravity','claude','codex'])`
 * com os padrões reais do scheduler, os TRÊS degraus vieram com
 * `Gemini 3.7 Flash (Medium)` — porque `modelByRole` é uma constante do
 * Antigravity aplicada a qualquer motor. Ou seja: o degrau do claude do rodízio
 * está morto na chegada hoje, e ninguém tinha medido.
 *
 * Separa em espaço, hífen e sublinhado para valer também para o formato de
 * slug (`claude-sonnet-5` → `claude`) e para nomes como `GPT-OSS 120B (Medium)`
 * (→ `gpt`), que são os formatos reais dos três catálogos no banco.
 */
function marcaDoModelo(nome: string): string {
  return (
    nome
      .trim()
      .toLowerCase()
      .split(/[\s\-_]+/)[0] ?? ''
  ).trim()
}

/**
 * O que fazer com o degrau, depois de conferir o modelo contra o catálogo.
 *
 * - `vale`: o modelo está vivo neste motor — ou o catálogo é desconhecido/vazio
 *   e a resposta honesta é "não sei" (FAIL-OPEN).
 * - `trocado`: o modelo saiu, mas existe equivalente de mesma família e mesmo
 *   esforço; o degrau roda com o substituto.
 * - `de-outro-motor`: a MARCA do nome não aparece em canto nenhum deste
 *   catálogo — o nome nunca foi deste motor. O degrau roda SEM `--model`, com o
 *   modelo padrão do próprio motor. Entregar trabalho com o modelo dele é
 *   melhor que pular um degrau que funcionaria.
 * - `saiu-do-catalogo`: a marca É deste motor, mas este modelo exato não está
 *   mais na lista e não há equivalente. Aqui a tentativa é desperdício com
 *   resultado conhecido (`invalid model selection`), e o degrau é PULADO.
 */
export type VereditoDoModelo = 'vale' | 'trocado' | 'de-outro-motor' | 'saiu-do-catalogo'

export interface EscolhaDeModelo {
  /**
   * O modelo que a missão deve usar. `undefined` quer dizer "rode sem
   * `--model`" — o motor escolhe o dele. Nunca é um palpite nosso.
   */
  modelo: string | undefined
  /** O que fazer com o degrau. Ver `VereditoDoModelo`. */
  veredito: VereditoDoModelo
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
  if (vivos.length === 0) return { modelo: desejado, veredito: 'vale', trocado: false }

  if (vivos.some((m) => m === desejado))
    return { modelo: desejado, veredito: 'vale', trocado: false }

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
    // A MARCA separa dois casos que pareciam um só e pedem coisas opostas.
    const marcaPedida = marcaDoModelo(desejado)
    const motorConheceAMarca = vivos.some((m) => marcaDoModelo(m) === marcaPedida)
    if (!motorConheceAMarca) {
      return {
        modelo: undefined,
        veredito: 'de-outro-motor',
        trocado: false,
        aviso:
          `o modelo "${desejado}" não é deste motor (nenhum dos ${vivos.length} modelos do ` +
          `catálogo dele é "${marcaPedida}") — o degrau roda com o modelo padrão do próprio motor ` +
          `em vez de morrer pedindo um modelo que ele não conhece`,
      }
    }
    return {
      modelo: undefined,
      veredito: 'saiu-do-catalogo',
      trocado: false,
      aviso:
        `o modelo "${desejado}" não está no catálogo vivo deste motor ` +
        `(${vivos.length} disponíveis: ${vivos.join(', ')}) e não há equivalente de mesma ` +
        `família e esforço para substituir`,
    }
  }

  return {
    modelo: candidato.nome,
    veredito: 'trocado',
    trocado: true,
    aviso:
      `o modelo "${desejado}" saiu do catálogo do provedor; usando "${candidato.nome}" ` +
      `(mesma família e mesmo esforço, geração mais nova disponível)`,
  }
}

/**
 * Um modelo que SAIU do catálogo do provedor, com a data em que percebemos.
 *
 * Ele não é apagado do registro: quem escolheu aquele modelo — no
 * `runtime_config` do projeto ou no painel — precisa saber que ele saiu, e
 * precisa saber HÁ QUANTO TEMPO. Uma lista que só encolhe some com a
 * informação: o modelo simplesmente desaparece da tela e ninguém liga a queda
 * das missões à remoção do provedor. Foi exatamente o que aconteceu em 31/08.
 */
export interface ModeloIndisponivel {
  nome: string
  /** ISO 8601. A PRIMEIRA vez que a coleta não o encontrou mais. */
  sumiuEm: string
}

function ehModeloIndisponivel(v: unknown): v is ModeloIndisponivel {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { nome?: unknown }).nome === 'string' &&
    (v as { nome: string }).nome.length > 0
  )
}

/**
 * Recalcula a lista de indisponíveis a partir de uma coleta BEM-SUCEDIDA.
 *
 * Só pode ser chamada com um catálogo novo de verdade — coleta que falhou ou
 * voltou vazia não prova ausência nenhuma, e marcar por ela transformaria uma
 * queda de rede em "o provedor removeu 14 modelos".
 *
 * A data de saída é preservada quando o modelo continua fora: carimbar de novo
 * a cada coleta faria toda ausência parecer de agora, e "sumiu há 5 minutos" e
 * "sumiu há 3 semanas" pedem reações diferentes do dono.
 *
 * Compara pelo NOME DE EXIBIÇÃO nos dois lados: as linhas antigas do banco
 * guardavam `slug<TAB>Nome`, e comparar cru marcaria o catálogo inteiro como
 * sumido na primeira coleta nova.
 */
export function atualizarModelosIndisponiveis(args: {
  anterior: readonly string[]
  atual: readonly string[]
  indisponiveis: readonly ModeloIndisponivel[]
  agora: Date
}): ModeloIndisponivel[] {
  const normalizar = (lista: readonly string[]): string[] =>
    lista
      .filter((m) => typeof m === 'string')
      .map(nomeDeExibicaoDoModelo)
      .filter(Boolean)

  const antes = normalizar(args.anterior)
  const agora = new Set(normalizar(args.atual))
  const jaMarcados = new Map(
    args.indisponiveis.filter(ehModeloIndisponivel).map((m) => [m.nome, m] as const)
  )

  const carimbo = args.agora.toISOString()
  const saidos: ModeloIndisponivel[] = []
  const vistos = new Set<string>()

  // O que já estava marcado e NÃO voltou continua marcado, com a data original.
  for (const [nome, marcado] of jaMarcados) {
    if (agora.has(nome)) continue
    vistos.add(nome)
    saidos.push({ nome, sumiuEm: marcado.sumiuEm ?? carimbo })
  }
  // E o que estava no catálogo anterior e não está mais entra agora.
  for (const nome of antes) {
    if (agora.has(nome) || vistos.has(nome)) continue
    vistos.add(nome)
    saidos.push({ nome, sumiuEm: jaMarcados.get(nome)?.sumiuEm ?? carimbo })
  }
  return saidos
}
