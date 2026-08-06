// Quem está com a bola AGORA, visível na própria issue.
//
// As labels existentes dizem o TIPO de trabalho (`gitorch:incident`,
// `gitorch:task`), a prioridade (`P0`..`P3`) e a delegação (`jules`) — nenhuma
// diz em que ponto da esteira a issue está. Sem isso não dá para ler
// RA → PO → SM → DEV → QA de relance no quadro, que é justamente a visão que o
// dono do projeto compra.
//
// Regra: UM agente por vez. Quando outro assume, o label do anterior sai —
// senão a issue acumula rastro e volta a não dizer nada.

export const AGENT_LABEL_PREFIX = 'gitorch:agent:'

/** Papéis que podem estar com a bola (inclui o dev assíncrono). */
export type AgenteAtuante = 'ra' | 'po' | 'sm' | 'jules' | 'qa'

export function agentLabel(agente: AgenteAtuante): string {
  return `${AGENT_LABEL_PREFIX}${agente}`
}

export function ehLabelDeAgente(label: string): boolean {
  return label.startsWith(AGENT_LABEL_PREFIX)
}

export interface AplicarLabelDeps {
  repository: string
  issueNumber: number
  agente: AgenteAtuante
  lerLabels: (repository: string, issueNumber: number) => Promise<string[]>
  adicionarLabel: (label: string) => Promise<void>
  removerLabel: (label: string) => Promise<void>
  onWarn?: (message: string) => void
}

/**
 * Marca a issue com o agente atuante e tira o marcador do agente anterior.
 *
 * NUNCA lança: rotular é sinalização, não o trabalho em si — se o GitHub
 * estiver fora, o agente segue e a issue fica sem o marcador daquela rodada.
 * Nunca toca em labels de tipo, prioridade ou delegação.
 */
export async function aplicarLabelDoAgente(deps: AplicarLabelDeps): Promise<void> {
  const alvo = agentLabel(deps.agente)
  const warn = deps.onWarn ?? (() => undefined)

  try {
    const atuais = await deps.lerLabels(deps.repository, deps.issueNumber)
    if (atuais.includes(alvo)) return // já é dele: não gera ruído no histórico

    await deps.adicionarLabel(alvo)
    for (const antigo of atuais.filter((l) => ehLabelDeAgente(l) && l !== alvo)) {
      await deps.removerLabel(antigo)
    }
  } catch (err) {
    warn(
      `[agent-label] não foi possível atualizar o label de agente da issue #${deps.issueNumber}: ${
        (err as Error).message
      }`
    )
  }
}
