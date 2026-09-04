import {
  analisarCustoDaOrdem,
  ordemQueMinimizaEspera,
  type CandidatoDeTroca,
  type PedidoNaFila,
} from '@gitorch/cadence'

// A caixa "Sua ordem custa caro?" ligada ao relógio: por PROJETO, lê a fila
// do quadro (ordem + peso — o que já existe), calcula, e — só quando vale a
// pena — PERGUNTA ao dono, formalmente (D71/L4-T18: 3 opções + escrever),
// com o pedido e o número.
//
// A LEI DO DESENHO ("você sempre decide") está na FORMA deste arquivo, não
// só no comentário: repare que `DepsDeCustoDaOrdem` não expõe NENHUMA
// função de escrita no quadro (nada como `moverItemDoQuadro`). Esta função
// estruturalmente não tem como reordenar nada — só pode ler a fila, calcular
// e perguntar. Quem decide o que fazer é o dono, clicando um dos 3 botões
// (ou escrevendo) no Telegram/painel — e quem EXECUTA a decisão dele é
// `processarRespostaDeCustoDaOrdem` (aviso-de-custo-da-ordem.ts), um arquivo
// à parte, só depois da resposta chegar.

/** Um projeto, do jeito mínimo que esta avaliação precisa dele. */
export interface ProjetoParaAvaliar {
  id: string
  wingId: string
}

/**
 * L4-T18 — o dono respondeu "manter minha ordem": este candidato fica
 * silenciado até `ate`, NUNCA para sempre ("manter" é uma decisão do agora,
 * não um "nunca mais pergunte sobre isto"). `rodada` é a rodada em que o
 * silêncio nasceu — a PRÓXIMA pergunta sobre este mesmo pedido, depois que o
 * silêncio vencer, usa `rodada + 1` no dedupKey (ver
 * `dedupKeyDeCustoDaOrdem`, aviso-de-custo-da-ordem.ts): reabrir com a MESMA
 * chave devolveria a resposta "manter" antiga em silêncio (dedup de
 * `AgentQuestionService.ask`), fingindo que o dono foi perguntado de novo
 * quando não foi.
 */
export interface SilencioDeCandidato {
  pedido: number
  ate: string
  rodada: number
}

/**
 * O que já foi proposto para este projeto — para não repetir a MESMA
 * pergunta a cada passada do relógio. `ultimoPedidoProposto: null` = nunca
 * propôs nada, ou a última proposta já deixou de valer (a ordem mudou, ou
 * deixou de custar caro).
 *
 * Guardado em `Project.runtimeConfig.custoDaOrdem` (JSON já existente no
 * schema, mesmo padrão de `resolveQuadroDoProjeto`/`agent-question.ts`) —
 * nenhuma tabela nova, nenhuma migração.
 */
export interface EstadoDoAvisoDeCustoDaOrdem {
  ultimoPedidoProposto: number | null
  /** `null` = nenhum silêncio ativo (ver `SilencioDeCandidato`). */
  silencio: SilencioDeCandidato | null
  /**
   * L4-T18 fix-up (item 3) — a ordem (sequência de números de pedido) que
   * `ordemQueMinimizaEspera` calculou da fila NO MOMENTO em que se
   * perguntou ao dono — a mesma que o texto do aviso descreve. Guardada
   * junto com o resto do estado para `processarRespostaDeCustoDaOrdem`
   * (aviso-de-custo-da-ordem.ts) comparar na hora de "aplicar": se a fila
   * mudou entre a pergunta e a resposta, a ordem recém-calculada pode não
   * ser mais esta, e aplicar às cegas seria "o dono aprova uma coisa, o
   * produto aplica outra". `null` = nenhuma ordem guardada (estado limpo,
   * ou pergunta de antes deste campo existir).
   */
  ordemProposta: number[] | null
}

export interface DepsDeCustoDaOrdem {
  /** Os projetos a avaliar nesta passada. */
  projetos: () => Promise<ProjetoParaAvaliar[]>
  /**
   * A fila do quadro deste projeto, NA ORDEM que está lá, com o peso de cada
   * item. `null` quando não deu para ler com confiança (sem quadro, sem
   * credencial, campo "Peso" ausente, algum item sem peso planejado) — é
   * SILÊNCIO desta passada, nunca um erro: o produto tenta de novo na
   * próxima, e nunca inventa um peso que não tem.
   */
  filaDoQuadro: (projeto: ProjetoParaAvaliar) => Promise<PedidoNaFila[] | null>
  lerEstado: (projectId: string) => Promise<EstadoDoAvisoDeCustoDaOrdem>
  salvarEstado: (projectId: string, estado: EstadoDoAvisoDeCustoDaOrdem) => Promise<void>
  /**
   * L4-T18 (D71): pergunta FORMAL ao dono — 3 opções (aplicar/manter/ver a
   * fila) + o botão de escrever, dedupada por repositório+pedido — nunca
   * mais um texto solto sem botão. `rodada` é a que `deps.avisar` deve usar
   * no dedupKey desta pergunta (ver `dedupKeyDeCustoDaOrdem`,
   * aviso-de-custo-da-ordem.ts): 1 na primeira vez, `silencio.rodada + 1`
   * quando um "manter" anterior sobre o MESMO pedido já venceu.
   */
  avisar: (
    projeto: ProjetoParaAvaliar,
    candidato: CandidatoDeTroca,
    rodada: number
  ) => Promise<void>
  /** Um projeto não pode travar os outros. Chamado, nunca lançado de novo. */
  onErro?: (projeto: ProjetoParaAvaliar, err: unknown) => void
  /** Injetável para teste — mesmo padrão de `DepsDaOrdem.agora` (ordem-dos-pedidos.ts). */
  agora?: () => Date
}

export interface ResumoDaAvaliacao {
  avaliados: number
  avisados: number
}

const ESTADO_LIMPO: EstadoDoAvisoDeCustoDaOrdem = {
  ultimoPedidoProposto: null,
  silencio: null,
  ordemProposta: null,
}

/**
 * L4-T18 fix-up (itens 3 e 4) — parsing PURO do que está gravado em
 * `Project.runtimeConfig.custoDaOrdem` (JSON) — extraído para ser testável
 * sem Fastify/Prisma. `scheduler.ts` (`lerEstado`) só faz a leitura do banco
 * e delega aqui; `plugins/telegram.ts` (`ordemProposta`, dep de
 * `processarRespostaDeCustoDaOrdem`) reusa a MESMA função, para nunca
 * duplicar este parsing uma terceira vez.
 *
 * Item 4 — o defeito real: `silencio.ate` era lido assumindo STRING
 * (`typeof === 'string'`). Se a configuração devolvesse uma DATA de verdade
 * (`Date`) em vez de texto — ex.: um armazenamento que não serializa JSON à
 * risca —, o guard rejeitava o silêncio inteiro, e a marca de "manter" se
 * perdia sem ninguém notar (o candidato voltava a ser perguntado antes da
 * hora, como se o dono nunca tivesse respondido). Os dois formatos (string
 * ISO — o que `telegram.ts` sempre grava, via `.toISOString()` — ou `Date`)
 * são aceitos e normalizados para string ISO; qualquer terceiro formato
 * invalida só o SILÊNCIO, nunca o resto do estado.
 */
export function lerEstadoBrutoDoAvisoDeCustoDaOrdem(bruto: unknown): EstadoDoAvisoDeCustoDaOrdem {
  if (!bruto || typeof bruto !== 'object') return ESTADO_LIMPO

  const objeto = bruto as {
    ultimoPedidoProposto?: unknown
    silencio?: unknown
    ordemProposta?: unknown
  }

  const valorProposto = objeto.ultimoPedidoProposto
  const ultimoPedidoProposto = typeof valorProposto === 'number' ? valorProposto : null

  const silencioBruto = objeto.silencio as
    { pedido?: unknown; ate?: unknown; rodada?: unknown } | null | undefined
  const ateBruta = silencioBruto?.ate
  const ateNormalizada =
    typeof ateBruta === 'string'
      ? ateBruta
      : ateBruta instanceof Date
        ? ateBruta.toISOString()
        : null
  const silencio =
    silencioBruto &&
    typeof silencioBruto.pedido === 'number' &&
    ateNormalizada !== null &&
    typeof silencioBruto.rodada === 'number'
      ? { pedido: silencioBruto.pedido, ate: ateNormalizada, rodada: silencioBruto.rodada }
      : null

  const ordemPropostaBruta = objeto.ordemProposta
  const ordemProposta =
    Array.isArray(ordemPropostaBruta) && ordemPropostaBruta.every((v) => typeof v === 'number')
      ? (ordemPropostaBruta as number[])
      : null

  return { ultimoPedidoProposto, silencio, ordemProposta }
}

export async function avaliarCustoDaOrdemDosProjetos(
  deps: DepsDeCustoDaOrdem
): Promise<ResumoDaAvaliacao> {
  const projetos = await deps.projetos()
  const agora = deps.agora ?? (() => new Date())
  let avisados = 0

  // EM SÉRIE, mesmo motivo das varreduras irmãs do relógio (scheduler.ts): um
  // projeto lento ou com defeito não pode atrasar nem derrubar os outros, e a
  // credencial pode ser compartilhada entre projetos do mesmo dono.
  for (const projeto of projetos) {
    try {
      const fila = await deps.filaDoQuadro(projeto)
      if (!fila) continue // não deu para ler com confiança — tenta na próxima passada

      const analise = analisarCustoDaOrdem(fila)
      const estado = await deps.lerEstado(projeto.id)

      if (!analise.custaCaro) {
        // A ordem deixou de custar caro (ou nunca custou). Limpa a marca:
        // se um candidato de verdade aparecer depois — mesmo que seja o
        // MESMO pedido de antes — ele precisa poder ser perguntado de novo.
        if (estado.ultimoPedidoProposto !== null || estado.silencio) {
          await deps.salvarEstado(projeto.id, ESTADO_LIMPO)
        }
        continue
      }

      const candidato = analise.candidato
      const silencioDoCandidato =
        estado.silencio?.pedido === candidato.pedido ? estado.silencio : null

      // "Manter" ainda dentro do período: o dono já decidiu, por agora.
      if (silencioDoCandidato && agora().getTime() < new Date(silencioDoCandidato.ate).getTime()) {
        continue
      }

      // MESMO candidato já proposto, sem silêncio (ainda em aberto, ou
      // respondido com algo que não fecha a decisão — "ver a fila"/texto
      // livre): o dono já sabe. Repetir a cada passada é a rajada de avisos
      // de rotina que ele já reclamou (29/08, classe-do-aviso.ts).
      if (estado.ultimoPedidoProposto === candidato.pedido && !silencioDoCandidato) continue

      // Ou é a primeira vez, ou o silêncio de um "manter" anterior já
      // venceu — pergunta de novo, na PRÓXIMA rodada (dedupKey distinto:
      // ver o comentário de `SilencioDeCandidato`).
      const rodada = silencioDoCandidato ? silencioDoCandidato.rodada + 1 : 1
      await deps.avisar(projeto, candidato, rodada)
      // Item 3 (fix-up) — guarda a ordem PROPOSTA junto com o resto do
      // estado, calculada da MESMA fila que gerou o candidato/o texto do
      // aviso: é o que `processarRespostaDeCustoDaOrdem`
      // (aviso-de-custo-da-ordem.ts) compara na hora de "aplicar".
      await deps.salvarEstado(projeto.id, {
        ultimoPedidoProposto: candidato.pedido,
        silencio: null,
        ordemProposta: ordemQueMinimizaEspera(fila).map((item) => item.pedido),
      })
      avisados++
    } catch (err) {
      deps.onErro?.(projeto, err)
    }
  }

  return { avaliados: projetos.length, avisados }
}
