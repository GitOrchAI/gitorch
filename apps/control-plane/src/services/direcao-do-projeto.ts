// Fase 2.5: um pedido feito FORA do GitOrch (você com um assistente, ou
// outra pessoa) carrega uma decisão de rumo que o time não tomou sozinho.
// Grava essa direção na memória do RA e do PO — as DUAS salas que
// buildMissionEnricher já lê para papéis != po (RA direto) e que o PO lê
// via qaDrawers/raIntact (mission-context.ts:130-165) — para a PRÓXIMA
// missão entender o contexto sem repetir a pergunta.

import { persistMissionMemory, type MissionMemory } from './mission-context.js'
import type { OrigemDoItem } from './origem-do-item.js'
import type { EntendimentoDoItem } from './ficha-do-item.js'
import type { F6AgentRole } from '@gitorch/agents'

/** Só pedido de FORA do GitOrch carrega direção nova — Jules pelo GitOrch e
 *  Dependabot são o próprio produto/automação agindo, não uma decisão de
 *  rumo externa. */
const ORIGENS_DE_FORA = new Set<OrigemDoItem>(['assistente', 'pessoa', 'jules_fora'])

export async function registrarDirecaoDoProjeto(args: {
  projectId: string
  origem: OrigemDoItem
  entendimento: EntendimentoDoItem
  deps: { cortex: MissionMemory; now: () => string }
}): Promise<void> {
  if (!ORIGENS_DE_FORA.has(args.origem)) return

  const conteudo =
    `Direção de fora do GitOrch (origem: ${args.origem}): ${args.entendimento.porQueExiste}. ` +
    `Mudança: ${args.entendimento.oQueMuda}.`

  for (const role of ['ra', 'po'] as const) {
    await persistMissionMemory(args.deps.cortex, {
      projectId: args.projectId,
      role: role as F6AgentRole,
      content: conteudo,
      now: args.deps.now(),
    })
  }
}
