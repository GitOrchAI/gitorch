import { parseDedupKeyDeDuvidaDoDev, PREFIXO_DUVIDA_DEV } from './dedup-key-de-duvida.js'

/**
 * D72 (02/09), item 5 — a varredura de LIMPEZA. Os itens 1-4 fecham a
 * torneira para escaladas NOVAS, mas não tiram do ar as perguntas que o
 * dono JÁ FLAGROU AO VIVO no painel/Telegram, quebradas: "O dev assíncrono
 * está parado na tarefa #309 de GitOrchAI/gitorch esperando uma decisão
 * sua. Pergunta original do dev: 'I have successfully modified...'" — com
 * UM botão só. Sem esta varredura, aquelas 4 perguntas ficariam presas em
 * "Esperando você" para sempre (nada mais as revisita).
 *
 * Idempotente por design: toda `agent_question` `open` com `dedupKey`
 * começando com `duvida-dev:` e menos de 4 opções (3 executivas + a 4ª
 * livre — a MESMA invariante de `ErroDePerguntaSemOpcoes`, agent-question.ts)
 * é encerrada com uma marca HONESTA (`marcarAssumida`, NUNCA finge que uma
 * decisão real aconteceu) — sai de "Esperando você" e não soa o Telegram de
 * novo (marcarAssumida nunca notifica). Não tenta reformar uma suposição
 * técnica aqui: esta varredura roda no relógio do tique (`scheduler.ts`,
 * `reconciliarDuvidasEscaladasLegadas`), FORA de qualquer missão — sem um
 * `StepExecutor` disponível, MESMA limitação já documentada para
 * `session-watch.ts` antes de L4-T4. Uma dúvida técnica genuína que ainda
 * precisar de resposta vai aparecer de novo pelo caminho normal (já
 * consertado) na próxima vez que o dev perguntar.
 */

export interface PrismaAgentQuestionParaReprocessar {
  agentQuestion: {
    findMany: (args: {
      where: { projectId: string; status: 'open'; dedupKey: { startsWith: string } }
    }) => Promise<Array<{ id: string; dedupKey: string | null; options: unknown }>>
  }
}

export interface DepsDeReprocessarPerguntasSemOpcoes {
  prisma: PrismaAgentQuestionParaReprocessar
  /** `AgentQuestionService.marcarAssumida`, já vinculado à instância real. */
  marcarAssumida: (args: {
    questionId: string
    projectId: string
    suposicao: string
  }) => Promise<unknown>
  onWarn: (mensagem: string) => void
}

export interface ResumoDoReprocessamento {
  encontradas: number
  reprocessadas: number
  falhas: number
}

/** 3 opções objetivas + a 4ª livre — a MESMA invariante da guarda de `ask()`. */
const QUANTIDADE_DE_OPCOES_ESPERADA = 4

function estaQuebrada(options: unknown): boolean {
  return !Array.isArray(options) || options.length < QUANTIDADE_DE_OPCOES_ESPERADA
}

/** O texto honesto que fecha a pergunta quebrada — nunca finge uma decisão. */
function textoDeReprocessamento(dedupKey: string | null): string {
  const parsed = dedupKey ? parseDedupKeyDeDuvidaDoDev(dedupKey) : null
  const referenciaDaTarefa = parsed
    ? `tarefa #${parsed.issueNumber} de ${parsed.repository}`
    : 'esta tarefa'
  return (
    `Pergunta reformulada pelo produto (D72): a versão anterior não tinha as 3 opções ` +
    `executivas exigidas e foi encerrada automaticamente. Se ainda houver uma dúvida técnica ` +
    `pendente na ${referenciaDaTarefa}, ela será reaberta corretamente (com as 3 opções) na ` +
    `próxima vez que o dev perguntar.`
  )
}

export async function reprocessarPerguntasSemOpcoesDoProjeto(
  args: { projectId: string },
  deps: DepsDeReprocessarPerguntasSemOpcoes
): Promise<ResumoDoReprocessamento> {
  const candidatas = await deps.prisma.agentQuestion.findMany({
    where: {
      projectId: args.projectId,
      status: 'open',
      dedupKey: { startsWith: PREFIXO_DUVIDA_DEV },
    },
  })

  const quebradas = candidatas.filter((c) => estaQuebrada(c.options))
  const resumo: ResumoDoReprocessamento = {
    encontradas: quebradas.length,
    reprocessadas: 0,
    falhas: 0,
  }

  for (const pergunta of quebradas) {
    try {
      await deps.marcarAssumida({
        questionId: pergunta.id,
        projectId: args.projectId,
        suposicao: textoDeReprocessamento(pergunta.dedupKey),
      })
      resumo.reprocessadas += 1
    } catch (err) {
      resumo.falhas += 1
      deps.onWarn(
        `reprocessarPerguntasSemOpcoes: não deu para reprocessar a pergunta ${pergunta.id} ` +
          `(projeto ${args.projectId}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return resumo
}
