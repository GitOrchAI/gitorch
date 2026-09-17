// Grava o formulário de entendimento (Fase 2.4) nos DOIS lugares que a Fase 3
// precisa: a ficha do item (decisão rápida, ficha-do-item.ts) e a memória do
// projeto (persistMissionMemory, mission-context.ts — para o RA/PO de
// missões futuras aprenderem com o entendimento já feito).

import type { EntendimentoDoItem, TipoDoItem } from './ficha-do-item.js'
import type { MissionMemory } from './mission-context.js'
import { persistMissionMemory } from './mission-context.js'

/** O formato desta dependência é o MESMO de `atualizarFichaDoItem` (Tarefa
 *  0.1) com `prisma` já fechado por quem monta `deps` em produção — nunca
 *  uma função paralela: `deps.atualizarFicha = (args) =>
 *  atualizarFichaDoItem({ prisma, ...args }).then(() => undefined)`. */
export interface RegistrarEntendimentoDeps {
  atualizarFicha: (args: {
    projectId: string
    tipo: TipoDoItem
    numero: number
    estado: { status: string }
    entendimento: EntendimentoDoItem
  }) => Promise<void>
  cortex: MissionMemory
  now: () => string
}

export async function registrarEntendimentoDoPedido(args: {
  projectId: string
  numeroDoPr: number
  entendimento: EntendimentoDoItem
  deps: RegistrarEntendimentoDeps
}): Promise<void> {
  await args.deps.atualizarFicha({
    projectId: args.projectId,
    tipo: 'pr',
    numero: args.numeroDoPr,
    // A ficha já tem `estado`; esta chamada só acrescenta `entendimento` —
    // `atualizarFichaDoItem` (Tarefa 0.1, agora aceitando `entendimento?`)
    // faz upsert PARCIAL, nunca apaga o que já estava lá.
    estado: { status: 'entendido' },
    entendimento: args.entendimento,
  })

  const resumo = [
    `De onde veio: ${args.entendimento.deOndeVeio}`,
    `O que muda: ${args.entendimento.oQueMuda}`,
    `Que ajuste é: ${args.entendimento.queAjusteE}`,
    `Por que existe: ${args.entendimento.porQueExiste}`,
  ].join('\n')

  await persistMissionMemory(args.deps.cortex, {
    projectId: args.projectId,
    role: 'qa',
    content: `Entendimento do pull request #${args.numeroDoPr}:\n${resumo}`,
    now: args.deps.now(),
  })
}
