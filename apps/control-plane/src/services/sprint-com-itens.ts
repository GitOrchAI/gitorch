import { exigirPermissao, type NivelDeAutonomia } from '@gitorch/cadence'
import { CampoDeIteracaoAusenteError } from '@gitorch/github-sync'
import { hojeNoFuso, sprintCorrente, type Iteracao } from './garantir-sprint.js'
import { AGENT_LABEL_PREFIX } from './agent-label.js'

/**
 * A OUTRA METADE da sprint: pôr dentro dela o que o produto está tocando.
 *
 * O mecanismo de escrever a iteração de um card sempre existiu
 * (`github-backlog.setSprint` -> `ProjectV2Client.setIterationField`), mas só
 * dispara NO INSTANTE em que o Produto cria a árvore de um desejo novo.
 * O campo Sprint nasceu no quadro do dono em 30/08/2026; as issues são todas
 * anteriores. Ninguém nunca voltava para pôr no ciclo o que já estava lá.
 *
 * MEDIDO em 31/08/2026 no quadro #2 (GitOrchAI/gitorch): 122 itens, 4 com o
 * campo Sprint preenchido — e os 4 eram exatamente os criados naquele dia. O
 * painel anunciava "Sprint 1 · 30 ago a 1 set · 3 dias" com o ciclo vazio.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ, e é a decisão que mais importa: não puxa o
 * backlog para dentro do ciclo. Sprint que recebe 118 itens não é sprint, é o
 * backlog com outro nome — e o cliente perde a confiança na primeira semana,
 * porque a tela passa a prometer para três dias o que levaria meses.
 */

/** Por que um pedido entrou na sprint. Vira frase para o cliente ler. */
export type MotivoDeEntrada = 'missao-ativa' | 'pr-aberto' | 'etiqueta-de-execucao'

export interface ItemAtivo {
  /** O número da issue ou do PR — o que o dono reconhece. */
  pedido: number
  motivo: MotivoDeEntrada
}

/**
 * As etiquetas que significam "alguém está com a bola AGORA".
 *
 * `gitorch:agent:po` e `gitorch:agent:ra` ficam DE FORA de propósito, e isso
 * foi medido, não suposto: em 31/08/2026 o repositório tinha 52 issues abertas
 * com alguma etiqueta de agente, e 50 delas eram `:po`. O Produto carimba `po`
 * em toda fase, épico, feature e task que cria (`backlog-executor.ts`) — é
 * carimbo de QUEM ESCREVEU, não de quem está executando. Tratá-lo como
 * trabalho ativo arrastaria o backlog inteiro para dentro do ciclo, que é
 * exatamente o erro que este arquivo existe para não cometer.
 *
 * `sm`, `jules` e `qa` só aparecem quando a issue foi delegada, está sendo
 * construída ou está sendo julgada. No mesmo dia, eram 2 issues no total.
 */
export const ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA: readonly string[] = [
  `${AGENT_LABEL_PREFIX}sm`,
  `${AGENT_LABEL_PREFIX}jules`,
  `${AGENT_LABEL_PREFIX}qa`,
]

/** De onde sai o trabalho que está em curso. Cada fonte é um fato, não um palpite. */
export interface FontesDoTrabalhoAtivo {
  /**
   * Sessões do dev assíncrono ainda abertas (`DevSession.closedAt IS NULL`).
   * É o registro do produto de que aquela issue está sendo trabalhada agora.
   */
  sessoesVivas: () => Promise<
    ReadonlyArray<{ issueNumber: number; pullRequestNumber: number | null }>
  >
  /** Issues abertas com uma das `ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA`. */
  issuesComEtiquetaDeExecucao: () => Promise<readonly number[]>
}

/**
 * Junta as fontes numa lista sem repetição.
 *
 * A ORDEM das fontes é a força do motivo: uma issue com sessão viva entra como
 * `missao-ativa` mesmo que também tenha etiqueta, porque é o fato mais forte
 * que o produto tem sobre ela. Repetir o pedido com dois motivos faria a mesma
 * escrita duas vezes e contaria o item duas vezes no relatório.
 */
export async function levantarTrabalhoAtivo(fontes: FontesDoTrabalhoAtivo): Promise<ItemAtivo[]> {
  const sessoes = await fontes.sessoesVivas()
  const etiquetados = await fontes.issuesComEtiquetaDeExecucao()

  const ativos: ItemAtivo[] = []
  const vistos = new Set<number>()
  const juntar = (pedido: number, motivo: MotivoDeEntrada) => {
    if (vistos.has(pedido)) return
    vistos.add(pedido)
    ativos.push({ pedido, motivo })
  }

  for (const s of sessoes) juntar(s.issueNumber, 'missao-ativa')
  // O PR da sessão viva entra também: no quadro ele é um item próprio, e é
  // onde o trabalho está de fato acontecendo enquanto a issue espera revisão.
  for (const s of sessoes) {
    if (s.pullRequestNumber != null) juntar(s.pullRequestNumber, 'pr-aberto')
  }
  for (const n of etiquetados) juntar(n, 'etiqueta-de-execucao')

  return ativos
}

/** Um item do quadro, com a sprint que ele já tem (ou não). */
export interface ItemNoQuadro {
  itemId: string
  pedido: number
  iteracaoId: string | null
}

export interface EntradaNaSprint extends ItemAtivo {
  /** O id do item DENTRO do quadro (não o da issue). */
  itemId: string
}

export interface SelecaoDaSprint {
  /** Quem falta pôr no ciclo — a ÚNICA lista que vira escrita. */
  entram: EntradaNaSprint[]
  /** Já estava nesta iteração. Reescrever seria gasto sem efeito. */
  jaEstavam: number[]
  /**
   * Está em OUTRA iteração e NÃO é movido.
   *
   * Quem já tem ciclo foi posto lá por alguém — o Produto ao criar a árvore ou
   * o próprio dono no quadro. Arrastar para o ciclo de hoje reescreveria uma
   * decisão que não é nossa, e é o defeito que a prova de idempotência procura.
   */
  emOutraIteracao: number[]
  /** Ativo, mas não existe item no quadro para ele. Dito, nunca inventado. */
  foraDoQuadro: number[]
}

/**
 * A decisão inteira, sem rede: quem entra, quem já está, quem não se mexe.
 *
 * Separada da passada com I/O porque é aqui que mora a regra que o cliente
 * sente — e regra que só dá para exercitar com um servidor na frente acaba
 * não sendo exercitada.
 */
export function selecionarParaSprint(input: {
  itens: readonly ItemNoQuadro[]
  ativos: readonly ItemAtivo[]
  iteracaoCorrenteId: string
}): SelecaoDaSprint {
  const porPedido = new Map<number, ItemNoQuadro>()
  for (const item of input.itens) porPedido.set(item.pedido, item)

  const selecao: SelecaoDaSprint = {
    entram: [],
    jaEstavam: [],
    emOutraIteracao: [],
    foraDoQuadro: [],
  }

  for (const ativo of input.ativos) {
    const item = porPedido.get(ativo.pedido)
    if (!item) {
      selecao.foraDoQuadro.push(ativo.pedido)
      continue
    }
    if (item.iteracaoId === input.iteracaoCorrenteId) {
      selecao.jaEstavam.push(ativo.pedido)
      continue
    }
    if (item.iteracaoId !== null) {
      selecao.emOutraIteracao.push(ativo.pedido)
      continue
    }
    selecao.entram.push({ itemId: item.itemId, pedido: ativo.pedido, motivo: ativo.motivo })
  }

  return selecao
}

/** O pedaço do quadro que este serviço usa. `ProjectV2Client` já o satisfaz. */
export interface QuadroQueAceitaSprint {
  getIterationField(input: {
    projectId: string
    fieldName: string
  }): Promise<{ fieldId: string; iterations: Iteracao[] }>
  listarItensDoQuadro(
    projectId: string,
    opcoes?: { campoDeSprint?: string; onTruncado?: (lidos: number) => void }
  ): Promise<ItemNoQuadro[]>
  setIterationField(input: {
    projectId: string
    itemId: string
    fieldId: string
    iterationId: string
  }): Promise<string>
}

export interface DepsDaSprintComItens {
  quadro: QuadroQueAceitaSprint
  /** Nível de autonomia do projeto, lido na hora da chamada. */
  nivel: () => NivelDeAutonomia | null | undefined | string
  trabalhoAtivo: () => Promise<readonly ItemAtivo[]>
  /** Nome do campo de iteração no quadro do cliente (padrão "Sprint"). */
  campoDeSprint?: string
  /** O dia de hoje no fuso do dono, no formato do GitHub. */
  hoje?: () => string
}

export interface RelatorioDaSprint {
  /** A iteração que recebeu os itens; null quando hoje não há ciclo correndo. */
  iteracao: { id: string; titulo: string } | null
  entraram: readonly EntradaNaSprint[]
  jaEstavam: readonly number[]
  emOutraIteracao: readonly number[]
  foraDoQuadro: readonly number[]
  /** O teto de páginas cortou a leitura do quadro. */
  leituraIncompleta: boolean
  /** O que aconteceu, em português, para o cliente ler. */
  oQueFiz: string
}

const NADA: Omit<RelatorioDaSprint, 'iteracao' | 'oQueFiz'> = {
  entraram: [],
  jaEstavam: [],
  emOutraIteracao: [],
  foraDoQuadro: [],
  leituraIncompleta: false,
}

/**
 * Põe o trabalho em curso dentro do ciclo que está correndo hoje.
 *
 * A guarda vem PRIMEIRO, antes de qualquer chamada ao GitHub: este serviço
 * escreve no quadro do cliente, e recusar depois de já ter mexido em três
 * cards deixaria o quadro dele pela metade.
 *
 * Nunca move item que já tem ciclo, e nunca reescreve item que já está no
 * ciclo de hoje — as duas coisas juntas são o que faz rodar duas vezes ter o
 * mesmo efeito de rodar uma.
 */
export async function preencherSprintCorrente(
  deps: DepsDaSprintComItens,
  args: { projectId: string }
): Promise<RelatorioDaSprint> {
  // Mexer no campo Sprint de um card é ORGANIZAR o quadro: não propõe trabalho
  // novo nem mescla nada. Lança `EscritaNaoAutorizadaError` quando o cliente
  // não autorizou, e lança antes de ler o quadro dele.
  exigirPermissao(deps.nivel(), 'organizar')

  const campo = deps.campoDeSprint ?? 'Sprint'
  const hoje = (deps.hoje ?? (() => hojeNoFuso()))()

  let iteracoes: Iteracao[]
  let fieldId: string
  try {
    const lido = await deps.quadro.getIterationField({
      projectId: args.projectId,
      fieldName: campo,
    })
    iteracoes = lido.iterations
    fieldId = lido.fieldId
  } catch (erro) {
    // Só a AUSÊNCIA do campo é tolerada — é estado legítimo de quadro que
    // ainda não passou pela varredura que o cria. Rede, permissão e 502 sobem.
    if (!ausenciaDeCampo(erro)) throw erro
    return {
      ...NADA,
      iteracao: null,
      oQueFiz: `O seu quadro ainda não tem o campo "${campo}", então não havia ciclo onde pôr nada.`,
    }
  }

  const corrente = sprintCorrente(iteracoes, hoje)
  if (!corrente) {
    return {
      ...NADA,
      iteracao: null,
      oQueFiz:
        `Hoje (${hoje}) não há nenhum ciclo correndo no seu quadro ` +
        `(${iteracoes.length} configurado(s)), então não pus ninguém em sprint.`,
    }
  }

  const ativos = await deps.trabalhoAtivo()
  if (ativos.length === 0) {
    // Ler o quadro inteiro para não escrever nada é gasto puro — e a cada
    // tique. Sprint vazia é melhor que sprint mentirosa, e mais barata.
    return {
      ...NADA,
      iteracao: { id: corrente.id, titulo: corrente.title },
      oQueFiz: `Não há trabalho em andamento agora, então "${corrente.title}" ficou como estava.`,
    }
  }

  // UMA volta ao GitHub: `campoDeSprint` traz o ciclo de cada item junto com a
  // lista. É daqui que sai a idempotência — sem esse dado seria preciso ou
  // reescrever todo mundo, ou uma segunda consulta por item.
  let leituraIncompleta = false
  let itensLidos = 0
  const itens = await deps.quadro.listarItensDoQuadro(args.projectId, {
    campoDeSprint: campo,
    onTruncado: (lidos) => {
      leituraIncompleta = true
      itensLidos = lidos
    },
  })

  const selecao = selecionarParaSprint({
    itens,
    ativos,
    iteracaoCorrenteId: corrente.id,
  })

  for (const entrada of selecao.entram) {
    await deps.quadro.setIterationField({
      projectId: args.projectId,
      itemId: entrada.itemId,
      fieldId,
      iterationId: corrente.id,
    })
  }

  const frases: string[] = []
  frases.push(
    selecao.entram.length > 0
      ? `Pus ${selecao.entram.length} item(ns) em "${corrente.title}": ` +
          `${selecao.entram.map((e) => `#${e.pedido}`).join(', ')}.`
      : `"${corrente.title}" já tinha tudo que está em andamento; não mexi em nada.`
  )
  if (selecao.jaEstavam.length > 0) {
    frases.push(`${selecao.jaEstavam.length} já estava(m) no ciclo.`)
  }
  if (selecao.emOutraIteracao.length > 0) {
    frases.push(
      `${selecao.emOutraIteracao.map((n) => `#${n}`).join(', ')} já está(ão) em outro ciclo e não foram movidos.`
    )
  }
  if (selecao.foraDoQuadro.length > 0) {
    frases.push(
      `${selecao.foraDoQuadro.map((n) => `#${n}`).join(', ')} não está(ão) no seu quadro.`
    )
  }
  if (leituraIncompleta) {
    frases.push(
      `Atenção: não consegui ler o seu quadro inteiro, parei em ${itensLidos} itens — ` +
        `o que ficou fora dessa parte não foi tocado.`
    )
  }

  return {
    iteracao: { id: corrente.id, titulo: corrente.title },
    entraram: selecao.entram,
    jaEstavam: selecao.jaEstavam,
    emOutraIteracao: selecao.emOutraIteracao,
    foraDoQuadro: selecao.foraDoQuadro,
    leituraIncompleta,
    oQueFiz: frases.join(' '),
  }
}

/**
 * A falha foi "o campo não existe"?
 *
 * `instanceof` primeiro; o teste pelo `name` cobre o pacote carregado por dois
 * caminhos, em que duas classes iguais deixam de ser a mesma classe — a mesma
 * cicatriz que `garantir-sprint.ts` já carrega.
 */
function ausenciaDeCampo(erro: unknown): boolean {
  if (erro instanceof CampoDeIteracaoAusenteError) return true
  return erro instanceof Error && erro.name === 'CampoDeIteracaoAusenteError'
}
