// Grava o formulário de entendimento (Fase 2.4) nos DOIS lugares que a Fase 3
// precisa: a ficha do item (decisão rápida, ficha-do-item.ts) e a memória do
// projeto (Cortex — para as missões futuras aprenderem com o entendimento já
// feito).
//
// Três cuidados que fazem desta gravação algo que pode rodar a cada
// julgamento do QA:
//
//  - não mexe no retrato da ficha (`estado`): o entendimento só acrescenta;
//  - a gaveta vai para uma sala PRÓPRIA, e não para a sala `qa`, que o PO lê
//    como lacuna candidata a tarefa (mission-context.ts);
//  - é idempotente: o mesmo entendimento sobre o mesmo commit não regrava
//    nada, e a gaveta tem id determinístico, então regravar nunca duplica.

import type { EntendimentoDoItem, TipoDoItem } from './ficha-do-item.js'
import {
  PREFIXO_DA_GAVETA_DE_ENTENDIMENTO,
  SALA_DO_ENTENDIMENTO,
  type MissionMemory,
} from './mission-context.js'

/** Importância baixa de propósito: é rastro de consulta, não conhecimento de primeira linha. */
const IMPORTANCIA_DA_GAVETA = 0.2

export interface RegistrarEntendimentoDeps {
  /** A ficha do PR, para saber se o entendimento mudou. `null` = ficha ainda não existe. */
  lerFicha: (numero: number) => Promise<{ entendimento: EntendimentoDoItem | null } | null>
  /** O formato é o de `atualizarFichaDoItem` com o Prisma já fechado — nunca uma função paralela. */
  atualizarFicha: (args: {
    projectId: string
    tipo: TipoDoItem
    numero: number
    entendimento: EntendimentoDoItem
  }) => Promise<void>
  cortex: MissionMemory
  now: () => string
}

function estaCompleto(e: EntendimentoDoItem): boolean {
  return [e.deOndeVeio, e.oQueMuda, e.queAjusteE, e.porQueExiste].every(
    (campo) => typeof campo === 'string' && campo.trim().length > 0
  )
}

function ehIgual(a: EntendimentoDoItem | null | undefined, b: EntendimentoDoItem): boolean {
  return (
    !!a &&
    a.deOndeVeio === b.deOndeVeio &&
    a.oQueMuda === b.oQueMuda &&
    a.queAjusteE === b.queAjusteE &&
    a.porQueExiste === b.porQueExiste
  )
}

export async function registrarEntendimentoDoPedido(args: {
  projectId: string
  numeroDoPr: number
  /** O commit julgado: um commit novo gera uma gaveta nova. */
  headSha?: string | undefined
  entendimento: EntendimentoDoItem
  deps: RegistrarEntendimentoDeps
}): Promise<void> {
  // Entendimento pela metade na ficha é pior que nenhum: quem lê a ficha
  // trata "tem entendimento" como "o pedido foi compreendido".
  if (!estaCompleto(args.entendimento)) return

  const ficha = await args.deps.lerFicha(args.numeroDoPr)
  if (!ehIgual(ficha?.entendimento, args.entendimento)) {
    // A ficha já tem `estado`; esta chamada só acrescenta `entendimento` e
    // não manda `estado`, para não trocar o retrato do PR.
    await args.deps.atualizarFicha({
      projectId: args.projectId,
      tipo: 'pr',
      numero: args.numeroDoPr,
      entendimento: args.entendimento,
    })
  }

  const resumo = [
    `De onde veio: ${args.entendimento.deOndeVeio}`,
    `O que muda: ${args.entendimento.oQueMuda}`,
    `Que ajuste é: ${args.entendimento.queAjusteE}`,
    `Por que existe: ${args.entendimento.porQueExiste}`,
  ].join('\n')
  const content = `${PREFIXO_DA_GAVETA_DE_ENTENDIMENTO}${args.numeroDoPr}${
    args.headSha ? ` (commit ${args.headSha})` : ''
  }:\n${resumo}`

  // Id determinístico (projeto, PR, commit): regravar o mesmo julgamento
  // atualiza a gaveta em vez de somar outra.
  const id = `entendimento:${args.projectId}:${args.numeroDoPr}:${args.headSha ?? 'sem-commit'}`
  if (args.deps.cortex.getDrawerById?.(id)?.content === content) return

  const agora = args.deps.now()
  await args.deps.cortex.writeDrawer({
    id,
    wingId: args.projectId,
    roomId: SALA_DO_ENTENDIMENTO,
    hallId: 'entendimento',
    content,
    importance: IMPORTANCIA_DA_GAVETA,
    emotionalWeight: 0,
    createdAt: agora,
    validFrom: agora,
    confidence: 0.8,
    tags: ['qa', 'entendimento'],
  })
}
