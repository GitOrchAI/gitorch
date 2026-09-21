// Confere QUALQUER tarefa (mesmo criada à mão, fora do fluxo do PO) contra o
// padrão dos 8 campos, o peso e a presença no quadro/sprint. Reaproveita os
// MESMOS validadores que backlog-executor.ts já usa para o que o próprio PO
// escreve — a régua não muda por quem escreveu a issue.

import { validateDoD, DOD_FIELD_MAP, type DoDFields } from '@gitorch/cadence'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { pesoDoCorpoDaIssue } from './backlog-executor.js'

export interface ConferenciaDaTarefa {
  padraoOk: boolean
  erros: string[]
  peso: number | null
  noQuadro: boolean
  naSprint: boolean
}

/** Monta um DoDFields a partir do corpo bruto da issue, seção por seção —
 *  mesma fonte (`DOD_FIELD_MAP`) que a escrita já usa, nunca uma lista
 *  paralela de cabeçalhos. */
function camposDaIssue(titulo: string, corpo: string): DoDFields {
  const campos = { titulo } as DoDFields
  for (const { key, header } of DOD_FIELD_MAP) {
    campos[key] = lerSecaoDaIssue(corpo, header)
  }
  return campos
}

export function conferirTarefaSemPedido(deps: {
  titulo: string
  corpo: string
  estaNoQuadro: boolean
  estaNaSprintAtual: boolean
}): ConferenciaDaTarefa {
  const campos = camposDaIssue(deps.titulo, deps.corpo)
  const dod = validateDoD(campos)
  return {
    padraoOk: dod.ok,
    erros: dod.errors,
    peso: pesoDoCorpoDaIssue(deps.corpo),
    noQuadro: deps.estaNoQuadro,
    naSprint: deps.estaNaSprintAtual,
  }
}
