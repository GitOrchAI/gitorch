import { ordemQueMinimizaEspera, type CandidatoDeTroca, type PedidoNaFila } from '@gitorch/cadence'
import { buildFreeTextOption } from './telegram-bot.js'
import type { ResultadoDoManipuladorDeResposta } from './agent-question.js'
import type { PedidoNaOrdem } from './ordem-dos-pedidos.js'

/**
 * A frase do losango do desenho, com o número — "Y entregaria N antes. Quer
 * trocar?" — só que em pontos de peso, não em sprints.
 *
 * POR QUE NÃO "SPRINTS": o desenho original diz "Y entregaria 2 sprints
 * antes", mas o produto não mede velocidade nem capacidade por sprint em
 * lugar nenhum do código (conferido: `PESO_MAXIMO_DE_SPRINT`, em
 * packages/cadence/src/rails.ts, é o TETO de uma task, não uma taxa de
 * entrega). Converter pontos de peso em sprints exigiria inventar essa taxa
 * — um número que ninguém mediu, virando bonito e errado (a mesma armadilha
 * que a "CONFIGURAÇÃO É INDÍCIO, TESTE É PROVA" já puniu neste projeto).
 * "Pontos de peso" é a unidade que o produto JÁ usa para planejar
 * (ESCALA_DE_PESO) e que este cálculo já tem, medida — sem fabricar nada.
 */
export function formatarAvisoDeCustoDaOrdem(candidato: CandidatoDeTroca): string {
  const pontos = candidato.perda === 1 ? '1 ponto de peso' : `${candidato.perda} pontos de peso`
  return (
    `GitOrch: sua ordem atual está custando caro na fila — #${candidato.pedido} entregaria ` +
    `${pontos} mais cedo se a ordem mudasse (hoje espera ${candidato.esperaAtual}, ` +
    `esperaria ${candidato.esperaOtima} numa ordem que reduz a espera de todo mundo). ` +
    `Quer trocar? Sua ordem no quadro continua valendo até você decidir.`
  )
}

// L4-T18, item 1 (D71) — O AVISO VIRA PERGUNTA FORMAL: o texto acima
// (inalterado — não mexe no critério, só na entrega) passa a viajar com
// dedupKey + 3 opções objetivas + o botão de escrever, pelo MESMO caminho
// que `agent-question.ts`/`telegram-bot.ts` já usam para `automacao:` e
// `duvida-dev:` — nunca mais um `notify`/`avisar` de texto solto.

/** Prefixo do dedupKey de toda pergunta de custo da ordem. */
export const DEDUP_PREFIXO_CUSTO_DA_ORDEM = 'custo-da-ordem:'

export interface CustoDaOrdemDedupKey {
  repo: string
  pedido: number
  /**
   * Quantas vezes já se perguntou sobre ESTE MESMO candidato — 1 na primeira
   * pergunta. Sobe quando o dono responde "manter" (`VALOR_MANTER_ORDEM`), o
   * período de silêncio vence (`PERIODO_DE_SILENCIO_APOS_MANTER_MS`) e o
   * candidato CONTINUA sendo o pior da fila: `AgentQuestionService.ask`
   * dedupa por `{projectId, dedupKey, status: 'answered'}` (mesma disciplina
   * de `dedup-key-de-retomada.ts`, C1) — repetir a MESMA chave depois de
   * "manter" já respondido devolveria a resposta ANTIGA em silêncio
   * (`deduped: true`, nenhuma notificação nova), fingindo que o dono foi
   * avisado quando não foi. A rodada é o mesmo recurso que
   * `duvida-dev:<repo>:<issue>:<hash>` já usa para distinguir uma pergunta
   * GENUINAMENTE NOVA sobre o mesmo alvo — nunca um contador que muda a cada
   * passada do relógio (isso reproduziria o defeito que C1 corrigiu).
   */
  rodada: number
}

function repoParecUmRepositorioDoGithub(repo: string): boolean {
  return repo.includes('/')
}

/** Monta `custo-da-ordem:<repo>:<pedido>` (rodada 1) ou
 *  `custo-da-ordem:<repo>:<pedido>:<rodada>` (rodada > 1). VALIDA e lança em
 *  vez de montar uma chave quebrada em silêncio — mesma disciplina de
 *  `dedupKeyDeRetomada`/`dedupKeyDeDuvidaDoDev`. */
export function dedupKeyDeCustoDaOrdem(repo: string, pedido: number, rodada = 1): string {
  if (!repo || !repoParecUmRepositorioDoGithub(repo)) {
    throw new Error(
      `dedupKeyDeCustoDaOrdem: repo '${repo}' não parece um repositório do GitHub (esperado 'dono/nome')`
    )
  }
  if (!Number.isInteger(pedido) || pedido <= 0) {
    throw new Error(
      `dedupKeyDeCustoDaOrdem: pedido inválido (${pedido}) — precisa ser inteiro positivo`
    )
  }
  if (!Number.isInteger(rodada) || rodada <= 0) {
    throw new Error(
      `dedupKeyDeCustoDaOrdem: rodada inválida (${rodada}) — precisa ser inteiro positivo`
    )
  }
  return rodada === 1
    ? `${DEDUP_PREFIXO_CUSTO_DA_ORDEM}${repo}:${pedido}`
    : `${DEDUP_PREFIXO_CUSTO_DA_ORDEM}${repo}:${pedido}:${rodada}`
}

/** Lê a dedupKey de volta. Formato desconhecido/quebrado devolve `null`,
 *  nunca lança — quem chama só age para este formato exato. */
export function parseDedupKeyDeCustoDaOrdem(dedupKey: string): CustoDaOrdemDedupKey | null {
  if (!dedupKey.startsWith(DEDUP_PREFIXO_CUSTO_DA_ORDEM)) return null
  const resto = dedupKey.slice(DEDUP_PREFIXO_CUSTO_DA_ORDEM.length)
  const partes = resto.split(':')
  if (partes.length !== 2 && partes.length !== 3) return null
  const [repo, pedidoBruto, rodadaBruto] = partes
  const pedido = Number(pedidoBruto)
  const rodada = rodadaBruto === undefined ? 1 : Number(rodadaBruto)
  if (!repo || !repoParecUmRepositorioDoGithub(repo)) return null
  if (!Number.isInteger(pedido) || pedido <= 0) return null
  if (!Number.isInteger(rodada) || rodada <= 0) return null
  return { repo, pedido, rodada }
}

export interface OpcaoDeCustoDaOrdem {
  label: string
  value: string
}

export const VALOR_APLICAR_TROCA = 'aplicar'
export const VALOR_MANTER_ORDEM = 'manter'
export const VALOR_VER_FILA = 'ver-fila'

/** D71: 3 opções objetivas — o botão de escrever entra à parte (ver
 *  `perguntarSobreCustoDaOrdem`, mesmo padrão de `escalar-duvida-ao-dono.ts`). */
export const OPCOES_DE_CUSTO_DA_ORDEM: OpcaoDeCustoDaOrdem[] = [
  { label: 'Aplicar a troca sugerida', value: VALOR_APLICAR_TROCA },
  { label: 'Manter minha ordem', value: VALOR_MANTER_ORDEM },
  { label: 'Ver a fila antes de decidir', value: VALOR_VER_FILA },
]

/** Só o que `perguntarSobreCustoDaOrdem` precisa de `AgentQuestionService.ask`. */
export interface AgentQuestionAskerDeCustoDaOrdem {
  ask: (
    userId: string,
    projectId: string,
    input: {
      text: string
      options?: OpcaoDeCustoDaOrdem[]
      dedupKey?: string
    }
  ) => Promise<unknown>
}

export interface PerguntarSobreCustoDaOrdemArgs {
  userId: string
  projectId: string
  repo: string
  candidato: CandidatoDeTroca
  /** Ver `CustoDaOrdemDedupKey.rodada`. Ausente = 1 (a pergunta comum). */
  rodada?: number
}

/**
 * D71: pergunta ao dono (3 opções objetivas + "Vou escrever"), dedupada por
 * `custo-da-ordem:<repo>:<pedido>` — mesmo padrão de `perguntarAoDono`
 * (decisao-de-automacao.ts). NUNCA reordena nada sozinha — só pergunta; quem
 * decide o que fazer é `processarRespostaDeCustoDaOrdem`, abaixo, chamado
 * DEPOIS que o dono responder.
 */
export async function perguntarSobreCustoDaOrdem(
  args: PerguntarSobreCustoDaOrdemArgs,
  deps: { agentQuestion: AgentQuestionAskerDeCustoDaOrdem }
): Promise<void> {
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: formatarAvisoDeCustoDaOrdem(args.candidato),
    options: [...OPCOES_DE_CUSTO_DA_ORDEM, buildFreeTextOption()],
    dedupKey: dedupKeyDeCustoDaOrdem(args.repo, args.candidato.pedido, args.rodada ?? 1),
  })
}

// --- Resposta vira ação (item 2) -------------------------------------------

/**
 * 24h — o mesmo horizonte de "uma vez por janela" que o produto já usa para
 * não repetir aviso de rotina (ver a decisão de 02/09 sobre cota de motor
 * esgotada). Documenta POR QUANTO TEMPO a escolha "manter" vale antes do
 * candidato poder voltar a ser perguntado — nunca indefinidamente: "manter"
 * é uma decisão do AGORA, não um "nunca mais pergunte sobre isto".
 */
export const PERIODO_DE_SILENCIO_APOS_MANTER_MS = 24 * 60 * 60 * 1000

/** Item da fila já com o `itemId` do quadro — o que
 *  `processarRespostaDeCustoDaOrdem` precisa para poder reordenar de
 *  verdade (`aplicarOrdemDosPedidos` move por `itemId`, nunca por número de
 *  pedido). */
export interface ItemDaFilaComId extends PedidoNaFila {
  itemId: string
}

export interface DepsDeRespostaDeCustoDaOrdem {
  /** Lê a fila do quadro FRESCA (pode ter mudado desde a pergunta) — já
   *  resolvida para o projeto desta pergunta. `null` = não deu para ler com
   *  confiança (mesmo contrato de `DepsDeCustoDaOrdem.filaDoQuadro`). */
  filaAtual: () => Promise<ItemDaFilaComId[] | null>
  /** Aplica a ordem informada no quadro real — o caminho que JÁ EXISTE
   *  (`aplicarOrdemDosPedidos`, ordem-dos-pedidos.ts; quem injeta decide
   *  quadro/nível/registro). */
  aplicarOrdem: (pedidos: PedidoNaOrdem[]) => Promise<void>
  /** Registra a escolha "manter" e silencia ESTE candidato até `ate`. */
  silenciarCandidato: (args: { pedido: number; ate: Date }) => Promise<void>
  /** "Aplicar" mudou a ordem de verdade: o candidato antigo não existe
   *  mais — limpa a marca de "já propus" para o próximo cálculo nascer do
   *  zero, nunca preso a um pedido que já foi resolvido. */
  limparEstadoAposAplicar: () => Promise<void>
  agora?: () => Date
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

/** A fila atual, em texto, numerada — o que "ver a fila antes de decidir"
 *  devolve ao dono. */
export function textoDaFilaAtual(fila: readonly PedidoNaFila[]): string {
  if (fila.length === 0) return 'Sua fila está vazia agora.'
  const linhas = fila.map((item, indice) => `${indice + 1}. #${item.pedido} (peso ${item.peso})`)
  return `Sua fila agora, na ordem atual:\n${linhas.join('\n')}`
}

/**
 * A resposta do dono vira ação — o contrato exato de `ManipuladorDeResposta`
 * (`agent-question.ts`): roda ANTES de `answer()` marcar a pergunta
 * `answered`; se lançar, a exceção sobe e NADA é gravado (a pergunta
 * continua `open`, pronta para nova tentativa).
 *
 *   - "aplicar" (`VALOR_APLICAR_TROCA`): reordena o quadro pela ordem que
 *     MINIMIZA A ESPERA DE TODO MUNDO — reusa `ordemQueMinimizaEspera`
 *     (packages/cadence/custo-da-ordem.ts) tal como está, nunca
 *     reimplementado aqui. NUNCA decide sozinha: só executa o que a mesma
 *     conta que gerou o convite já apontava.
 *   - "manter" (`VALOR_MANTER_ORDEM`): não mexe em nada do quadro; só
 *     silencia ESTE pedido por `PERIODO_DE_SILENCIO_APOS_MANTER_MS`.
 *   - "ver-fila" (`VALOR_VER_FILA`): devolve a fila atual em texto
 *     (`aviso`, `ResultadoDoManipuladorDeResposta` — o mesmo canal
 *     EFÊMERO que `retomar-sessao-com-resposta.ts` já usa) e NÃO aplica
 *     nem silencia nada — a decisão de verdade (aplicar/manter) continua
 *     em aberto para o próximo ciclo perguntar de novo.
 *   - qualquer outra coisa (texto livre do "Vou escrever"): só registra,
 *     sem ação automática — mesma disciplina do `default` de
 *     `processarRespostaDeAutomacao`.
 */
export async function processarRespostaDeCustoDaOrdem(
  args: { dedupKey: string | null; resposta: string },
  deps: DepsDeRespostaDeCustoDaOrdem
): Promise<ResultadoDoManipuladorDeResposta | void> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)

  if (!args.dedupKey) return
  const parsed = parseDedupKeyDeCustoDaOrdem(args.dedupKey)
  if (!parsed) return

  switch (args.resposta) {
    case VALOR_APLICAR_TROCA: {
      const fila = await deps.filaAtual()
      if (!fila || fila.length === 0) {
        warn(`custo-da-ordem: 'aplicar' sem fila legível agora (dedupKey ${args.dedupKey})`)
        return {
          aviso:
            'Não consegui ler seu quadro agora para aplicar a troca. Nada foi mudado — tente de ' +
            'novo daqui a pouco.',
        }
      }

      const porPedido = new Map(fila.map((item) => [item.pedido, item.itemId]))
      const ordemAlvo = ordemQueMinimizaEspera(fila.map(({ pedido, peso }) => ({ pedido, peso })))
      const pedidosNaOrdem: PedidoNaOrdem[] = []
      for (const item of ordemAlvo) {
        const itemId = porPedido.get(item.pedido)
        if (itemId) pedidosNaOrdem.push({ pedido: item.pedido, itemId })
      }
      if (pedidosNaOrdem.length === 0) {
        warn(`custo-da-ordem: 'aplicar' sem itemId para nenhum pedido da fila (${args.dedupKey})`)
        return { aviso: 'Não consegui casar os pedidos da fila com o quadro — nada foi mudado.' }
      }

      await deps.aplicarOrdem(pedidosNaOrdem)
      await deps.limparEstadoAposAplicar()
      info(`custo-da-ordem: troca aplicada para #${parsed.pedido} (${args.dedupKey})`)
      return
    }

    case VALOR_MANTER_ORDEM: {
      const agora = (deps.agora ?? (() => new Date()))()
      const ate = new Date(agora.getTime() + PERIODO_DE_SILENCIO_APOS_MANTER_MS)
      await deps.silenciarCandidato({ pedido: parsed.pedido, ate })
      info(`custo-da-ordem: ordem mantida — #${parsed.pedido} silenciado até ${ate.toISOString()}`)
      return
    }

    case VALOR_VER_FILA: {
      const fila = await deps.filaAtual()
      const aviso = fila ? textoDaFilaAtual(fila) : 'Não consegui ler seu quadro agora.'
      return { aviso }
    }

    default: {
      // "Vou escrever": texto livre, só registrado — sem ação automática
      // (mesma disciplina do `default` de decisao-de-automacao.ts).
      info(`custo-da-ordem: resposta livre registrada para #${parsed.pedido}`)
      return
    }
  }
}
