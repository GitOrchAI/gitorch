import { ordemQueMinimizaEspera, type CandidatoDeTroca, type PedidoNaFila } from '@gitorch/cadence'
import { buildFreeTextOption } from './telegram-bot.js'
import type { ResultadoDoManipuladorDeResposta } from './agent-question.js'
import type { PedidoNaOrdem } from './ordem-dos-pedidos.js'
import {
  montarMensagemDeStakeholder,
  type DesejoParaMensagemDeStakeholder,
} from './mensagem-de-stakeholder.js'
import {
  coletarTamanhoDoDesejoDaTask,
  type DepsDoColetorPelaTask,
} from './coletor-de-desejo-para-stakeholder.js'

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
  /**
   * D76b (T10) — nome do dono, para a mensagem de stakeholder abrir com ele
   * ("Guilherme, a equipe..."). Ausente/vazio = abre sem saudação (nunca um
   * nome inventado). Só tem efeito quando `coletarTamanhoDoDesejo` (deps)
   * está presente — sem ele o texto continua o antigo, que nunca citou nome
   * nenhum.
   */
  nomeDoDono?: string
}

export interface DepsDePerguntarSobreCustoDaOrdem {
  agentQuestion: AgentQuestionAskerDeCustoDaOrdem
  /**
   * D76b (T10) — quando informado, a pergunta cita o TAMANHO REAL do desejo
   * candidato (fases/épicos/features/tarefas contados na árvore de issues,
   * formato de mensagem de stakeholder — `montarMensagemDeStakeholder`) em
   * vez de "pontos de peso" (o dono, 04-14/09: "quando é P2, quando é P0?
   * não vejo visualmente" — o mesmo problema de jargão que motivou esta
   * decisão). Devolve `null` = não deu para coletar agora (GitHub fora do
   * ar, credencial ausente, árvore ainda não montada) — cai para o texto
   * antigo, NUNCA quebra a pergunta por causa disso. Ausente (`undefined`)
   * = quem chama ainda não tem contexto de projeto/dono para buscar a
   * árvore (todo chamador de hoje) — mesmo efeito de `null`, texto antigo.
   *
   * Reaproveita `coletarDesejoParaMensagemDeStakeholder`
   * (coletor-de-desejo-para-stakeholder.ts) — quem monta este dep em
   * produção só precisa fechar `ownerId`/`projeto`/`titulo` numa closure em
   * cima dele; esta função não decide isso, só usa o que vier pronto.
   */
  coletarTamanhoDoDesejo?: (
    candidato: CandidatoDeTroca
  ) => Promise<DesejoParaMensagemDeStakeholder | null>
}

/** D76b (T10) — a mesma frase de fechamento que o texto antigo já usava
 *  ("continua valendo até você decidir"): a garantia ao dono não muda só
 *  porque a forma de citar o tamanho do desejo mudou. */
function propostaDeCustoDaOrdem(): string {
  return 'Quer trocar? Sua ordem no quadro continua valendo até você decidir.'
}

async function textoDaPerguntaDeCustoDaOrdem(
  args: PerguntarSobreCustoDaOrdemArgs,
  deps: DepsDePerguntarSobreCustoDaOrdem
): Promise<string> {
  if (!deps.coletarTamanhoDoDesejo) return formatarAvisoDeCustoDaOrdem(args.candidato)
  const desejo = await deps.coletarTamanhoDoDesejo(args.candidato)
  if (!desejo) return formatarAvisoDeCustoDaOrdem(args.candidato)
  return montarMensagemDeStakeholder({
    dono: args.nomeDoDono ?? '',
    desejos: [desejo],
    proposta: propostaDeCustoDaOrdem(),
  })
}

/**
 * D71: pergunta ao dono (3 opções objetivas + "Vou escrever"), dedupada por
 * `custo-da-ordem:<repo>:<pedido>` — mesmo padrão de `perguntarAoDono`
 * (decisao-de-automacao.ts). NUNCA reordena nada sozinha — só pergunta; quem
 * decide o que fazer é `processarRespostaDeCustoDaOrdem`, abaixo, chamado
 * DEPOIS que o dono responder.
 *
 * D76b (T10): o TEXTO passa a citar o tamanho real do desejo (fases/épicos/
 * features/tarefas) em vez de "pontos de peso" quando `deps.
 * coletarTamanhoDoDesejo` está disponível — ver `DepsDePerguntarSobreCustoDaOrdem`.
 * O TRANSPORTE (`agentQuestion.ask`, as mesmas 3 opções + dedupKey) não
 * muda: só o texto/dados que ele carrega.
 */
export async function perguntarSobreCustoDaOrdem(
  args: PerguntarSobreCustoDaOrdemArgs,
  deps: DepsDePerguntarSobreCustoDaOrdem
): Promise<void> {
  const texto = await textoDaPerguntaDeCustoDaOrdem(args, deps)
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: texto,
    options: [...OPCOES_DE_CUSTO_DA_ORDEM, buildFreeTextOption()],
    dedupKey: dedupKeyDeCustoDaOrdem(args.repo, args.candidato.pedido, args.rodada ?? 1),
  })
}

/**
 * Achado de QA (T10) — `perguntarSobreCustoDaOrdem` sabe montar o texto de
 * stakeholder desde que ganhe `coletarTamanhoDoDesejo`/`nomeDoDono` (acima),
 * mas o ÚNICO chamador de produção (`scheduler.ts`, `avisar`) nunca passava
 * nenhum dos dois — a pergunta caía SEMPRE no texto antigo de "pontos de
 * peso", mesmo com toda a leitura de árvore (T10) pronta e testada.
 *
 * Este é o adaptador que fecha as duas deps com fontes REAIS — extraído
 * para fora de `scheduler.ts` para poder ser testado sem Fastify/Prisma
 * (mesmo motivo de `lerEstadoBrutoDoAvisoDeCustoDaOrdem`,
 * custo-da-ordem-do-projeto.ts): `scheduler.ts` só monta as portas de I/O
 * (Prisma, credencial, o MESMO REST de `buscarIssueParaIncremento` que já
 * enriquece o Incremento) e delega para cá.
 */
export interface DepsDoAvisoComContextoReal {
  agentQuestion: AgentQuestionAskerDeCustoDaOrdem
  /**
   * `userId` do dono do projeto + o NOME do projeto (para achar o desejo na
   * árvore certa — `ArgsDoColetorPelaTask.projeto`, coletor-de-desejo-
   * para-stakeholder.ts). `null` = sem dono conhecido — a pergunta nem sai
   * (MESMA recusa silenciosa que `scheduler.ts` já fazia antes desta
   * correção; nunca pergunta sem saber a quem).
   */
  contextoDoProjeto: (
    projectId: string
  ) => Promise<{ userId: string; nomeDoProjeto: string } | null>
  /**
   * O NOME do dono, para a saudação — MESMA fonte que `buscarAutor`
   * (routes/index.ts) já usa para assinar issue de desejo em nome dele
   * (`User.name`). `null` = sem nome cadastrado — mensagem sem saudação,
   * nunca um nome inventado (contrato já documentado em
   * `PerguntarSobreCustoDaOrdemArgs.nomeDoDono`).
   */
  nomeDoDono: (userId: string) => Promise<string | null>
  /**
   * Credencial que alcança o repositório deste projeto — a do cliente
   * primeiro, a do app depois: a MESMA ordem que `filaDoQuadro`
   * (scheduler.ts) já usa para ler o quadro. Nunca um caminho de
   * autenticação novo. `null` = sem credencial — o coletor cai no texto
   * antigo.
   */
  token: (userId: string) => Promise<string | null>
  /**
   * Busca uma issue (a task candidata OU o desejo pai) pelo número, com o
   * token acima — a MESMA leitura REST que `buscarIssueParaIncremento`
   * (scheduler.ts) já faz para o registro do Incremento.
   */
  buscarIssue: (
    token: string,
    numero: number
  ) => Promise<{ titulo: string; corpo: string | null } | null>
}

/**
 * Constrói o `avisar` de `DepsDeCustoDaOrdem` (custo-da-ordem-do-projeto.ts)
 * já com o contexto REAL fechado: quem chama (`scheduler.ts`) só precisa
 * fornecer as portas de I/O de `DepsDoAvisoComContextoReal`; toda a costura
 * task → desejo → árvore → texto roda por dentro, terminando no MESMO
 * `perguntarSobreCustoDaOrdem` de sempre.
 *
 * NUNCA lança por causa da coleta do tamanho real: qualquer falha ao
 * resolver token/issue/árvore vira `null` para `coletarTamanhoDoDesejo` —
 * `perguntarSobreCustoDaOrdem` já sabe cair para o texto antigo quando isso
 * acontece, então uma falha de rede/GitHub aqui NUNCA quebra a missão (a
 * pergunta sai do mesmo jeito, só que no formato antigo).
 */
export function construirAvisoDeCustoDaOrdemComContextoReal(
  deps: DepsDoAvisoComContextoReal
): (
  projeto: { id: string; wingId: string },
  candidato: CandidatoDeTroca,
  rodada: number
) => Promise<void> {
  return async (projeto, candidato, rodada) => {
    const contexto = await deps.contextoDoProjeto(projeto.id)
    if (!contexto) return

    const nomeDoDono = (await deps.nomeDoDono(contexto.userId)) ?? undefined

    const coletarTamanhoDoDesejo = async (
      candidatoDaPergunta: CandidatoDeTroca
    ): Promise<DesejoParaMensagemDeStakeholder | null> => {
      try {
        const token = await deps.token(contexto.userId)
        if (!token) return null
        const buscarIssueComToken: DepsDoColetorPelaTask['buscarIssue'] = (numero) =>
          deps.buscarIssue(token, numero)
        return await coletarTamanhoDoDesejoDaTask(
          {
            ownerId: contexto.userId,
            projeto: contexto.nomeDoProjeto,
            numeroDaTask: candidatoDaPergunta.pedido,
            // Nenhum lugar do produto guarda prioridade/estimativa de
            // sprints do desejo hoje (ver o comentário de
            // `ArgsDoColetorDeDesejo`, coletor-de-desejo-para-stakeholder.ts)
            // — `null` até essa fonte existir de verdade, nunca um número
            // inventado.
            prioridade: null,
            sprintsEstimadas: null,
          },
          {
            buscarIssue: buscarIssueComToken,
            listarProjetos: async () => [
              { nome: contexto.nomeDoProjeto, repo: projeto.wingId, id: projeto.id },
            ],
            lerToken: async () => token,
          }
        )
      } catch {
        // Qualquer falha de leitura (rede, GitHub fora do ar, árvore
        // indisponível): nunca sobe — cai para o texto antigo, nunca quebra
        // a pergunta (ver o comentário desta função).
        return null
      }
    }

    await perguntarSobreCustoDaOrdem(
      {
        userId: contexto.userId,
        projectId: projeto.id,
        repo: projeto.wingId,
        candidato,
        rodada,
        // `exactOptionalPropertyTypes`: só entra a chave quando há nome de
        // verdade — nunca `nomeDoDono: undefined` explícito (mesmo padrão
        // de `projetoDaLinha`, arvore-de-pedidos.ts).
        ...(nomeDoDono ? { nomeDoDono } : {}),
      },
      { agentQuestion: deps.agentQuestion, coletarTamanhoDoDesejo }
    )
  }
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
  /**
   * L4-T18 fix-up (item 3) — a ordem (sequência de números de pedido) que
   * `ordemQueMinimizaEspera` calculou NO MOMENTO em que se perguntou ao dono
   * (guardada por `avaliarCustoDaOrdemDosProjetos`,
   * custo-da-ordem-do-projeto.ts, junto com o resto do estado). `null` =
   * nenhuma ordem guardada (pergunta de antes deste campo existir, ou
   * estado já limpo) — tratado como "mudou", nunca como "pode aplicar às
   * cegas".
   */
  ordemProposta: () => Promise<number[] | null>
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

      // Item 3 (fix-up) — a fila é lida FRESCA aqui, mas o texto que o dono
      // viu descrevia a ordem calculada NO MOMENTO da pergunta. Se a fila
      // mudou desde então (pedido novo, removido, ou peso diferente), a
      // ordem recém-calculada pode não ser mais a que ele aprovou — aplicar
      // do mesmo jeito seria "ele aprova uma coisa, o produto aplica
      // outra". Compara com a ordem GUARDADA junto com a pergunta; qualquer
      // divergência (ou ausência da guarda — pergunta antiga) recusa a
      // aplicação silenciosa.
      const ordemAtualEmPedidos = ordemAlvo.map((item) => item.pedido)
      const ordemPropostaSalva = await deps.ordemProposta()
      const filaMudouDesdeAPergunta =
        ordemPropostaSalva === null ||
        ordemPropostaSalva.length !== ordemAtualEmPedidos.length ||
        ordemPropostaSalva.some((pedido, indice) => pedido !== ordemAtualEmPedidos[indice])

      if (filaMudouDesdeAPergunta) {
        warn(`custo-da-ordem: 'aplicar' recusado — fila mudou desde a pergunta (${args.dedupKey})`)
        // Mesmo mecanismo do item 2 ("ver a fila"): silencia com `ate` JÁ
        // VENCIDO, para a decisão reabrir sozinha — com o candidato
        // recalculado da fila ATUAL — na próxima passada do relógio, em vez
        // de aplicar às cegas uma ordem diferente da que o dono aprovou.
        const agoraDaRecusa = (deps.agora ?? (() => new Date()))()
        await deps.silenciarCandidato({ pedido: parsed.pedido, ate: agoraDaRecusa })
        return {
          aviso:
            'Sua fila mudou desde que eu perguntei, então não apliquei nada para não trocar a ' +
            'ordem por engano. Vou te perguntar de novo já com a fila atual.',
        }
      }

      const pedidosNaOrdem: PedidoNaOrdem[] = []
      for (const item of ordemAlvo) {
        const itemId = porPedido.get(item.pedido)
        if (itemId) pedidosNaOrdem.push({ pedido: item.pedido, itemId })
      }
      if (pedidosNaOrdem.length === 0) {
        warn(`custo-da-ordem: 'aplicar' sem itemId para nenhum pedido da fila (${args.dedupKey})`)
        return { aviso: 'Não consegui casar os pedidos da fila com o quadro — nada foi mudado.' }
      }

      // Item 1 (fix-up) — se `aplicarOrdem` lançar, o `finally` garante que
      // `limparEstadoAposAplicar` roda DO MESMO JEITO: sem isso, o
      // `ultimoPedidoProposto` que a varredura gravou continua apontando
      // para este mesmo pedido, e a PRÓXIMA passada do relógio pula a
      // pergunta para sempre (custo-da-ordem-do-projeto.ts) — a pergunta
      // fica órfã. O erro CONTINUA subindo depois do `finally` (nunca
      // mascarado): é o que faz `answer()` (agent-question.ts) NÃO marcar
      // esta pergunta `answered`, devolvendo-a a `open` para nova tentativa.
      try {
        await deps.aplicarOrdem(pedidosNaOrdem)
      } finally {
        await deps.limparEstadoAposAplicar()
      }
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
      // Item 2 (fix-up) — "ver a fila" NÃO é uma decisão (aplicar/manter),
      // mas devolver aqui SEM LANÇAR faz `answer()` (agent-question.ts)
      // marcar a pergunta `answered` (o único outro desfecho do contrato de
      // `ManipuladorDeResposta` é lançar — e aí o aviso da fila NUNCA
      // chegaria ao dono, porque `avisoDoManipulador` só existe numa
      // resposta de SUCESSO). Com a dedupKey ESTÁVEL, isso travaria a
      // decisão para sempre: nenhuma pergunta nova sobre este pedido
      // nasceria de novo. Reusa o MESMO mecanismo de "manter"
      // (`silenciarCandidato`) para reabrir sem inventar um 3º desfecho no
      // contrato — só que com `ate` JÁ VENCIDO (agora, não +24h): a próxima
      // passada do relógio vê o silêncio expirado e pergunta de novo, na
      // rodada seguinte (dedupKey distinto da pergunta já respondida).
      const agoraDoSilencio = (deps.agora ?? (() => new Date()))()
      await deps.silenciarCandidato({ pedido: parsed.pedido, ate: agoraDoSilencio })
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
