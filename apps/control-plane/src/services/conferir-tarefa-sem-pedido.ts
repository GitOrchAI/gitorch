// Confere QUALQUER tarefa (mesmo criada à mão, fora do fluxo do PO) contra o
// padrão dos 8 campos, o peso e a presença no quadro/sprint. Reaproveita os
// MESMOS validadores que backlog-executor.ts já usa para o que o próprio PO
// escreve — a régua não muda por quem escreveu a issue.

import { createHash } from 'node:crypto'
import { validateDoD, DOD_FIELD_MAP, type DoDFields } from '@gitorch/cadence'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { pesoDoCorpoDaIssue } from './backlog-executor.js'

export interface ConferenciaDaTarefa {
  padraoOk: boolean
  erros: string[]
  peso: number | null
  /** `null` = o quadro não pôde ser lido: não se sabe. */
  noQuadro: boolean | null
  /** `null` = não se sabe (quadro ilegível ou nenhuma sprint correndo). */
  naSprint: boolean | null
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
  estaNoQuadro: boolean | null
  estaNaSprintAtual: boolean | null
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

/** O que a varredura guarda em `repo_items.conferencia` (coluna própria: nunca dentro de `estado`). */
export interface ConferenciaGravada {
  padraoOk: boolean
  /** Chaves do formulário que faltam (`goal`, `verificationCriteria`, `titulo`...). */
  camposFaltando: string[]
  /** As mensagens do validador, sem alteração. */
  erros: string[]
  /** A seção "## Peso" existe e traz um valor da escala. */
  pesoOk: boolean
  peso: number | null
  estaNoQuadro: boolean | null
  naSprint: boolean | null
  /** Alguém (SM, dev, QA) está com a tarefa na mão, pela etiqueta de agente. */
  emExecucao: boolean
  conferidoEm: string
  /** Impressão do título e do corpo conferidos: se mudar, a conferência é refeita. */
  hashDoCorpo: string
  /** Impressão do resultado (ok ou o conjunto de erros): um evento de painel por resultado. */
  hashDosErros: string
  /** `quadro:sim|sprint:nao`: se mudar, a conferência é regravada. */
  estadoDoQuadro: string
}

function resumir(texto: string): string {
  return createHash('sha256').update(texto).digest('hex').slice(0, 16)
}

/** Impressão estável do texto da tarefa (título e corpo). */
export function hashDoCorpoDaTarefa(titulo: string, corpo: string): string {
  return resumir(`${titulo}\u0000${corpo}`)
}

/** Impressão do resultado da conferência, igual para a mesma lista de erros em qualquer ordem. */
export function hashDosErros(padraoOk: boolean, erros: readonly string[]): string {
  if (padraoOk) return resumir('ok')
  return resumir([...erros].sort().join('\u0000'))
}

/** As chaves do formulário citadas pelas mensagens do validador (`goal: empty ...`), sem repetir. */
export function camposFaltandoDosErros(erros: readonly string[]): string[] {
  const chaves: string[] = []
  for (const erro of erros) {
    const chave = erro.split(':')[0]?.trim()
    if (chave && !chaves.includes(chave)) chaves.push(chave)
  }
  return chaves
}

function marcaDoQuadro(valor: boolean | null, nome: string): string {
  return `${nome}:${valor === null ? '?' : valor ? 'sim' : 'nao'}`
}

/** Resumo do que o quadro disse sobre a tarefa; muda quando ela entra ou sai do quadro ou da sprint. */
export function estadoDoQuadroDaConferencia(
  noQuadro: boolean | null,
  naSprint: boolean | null
): string {
  return `${marcaDoQuadro(noQuadro, 'quadro')}|${marcaDoQuadro(naSprint, 'sprint')}`
}

export function montarConferenciaGravada(args: {
  conferencia: ConferenciaDaTarefa
  titulo: string
  corpo: string
  emExecucao: boolean
  agora: Date
}): ConferenciaGravada {
  const { conferencia } = args
  return {
    padraoOk: conferencia.padraoOk,
    camposFaltando: camposFaltandoDosErros(conferencia.erros),
    erros: conferencia.erros,
    pesoOk: conferencia.peso !== null,
    peso: conferencia.peso,
    estaNoQuadro: conferencia.noQuadro,
    naSprint: conferencia.naSprint,
    emExecucao: args.emExecucao,
    conferidoEm: args.agora.toISOString(),
    hashDoCorpo: hashDoCorpoDaTarefa(args.titulo, args.corpo),
    hashDosErros: hashDosErros(conferencia.padraoOk, conferencia.erros),
    estadoDoQuadro: estadoDoQuadroDaConferencia(conferencia.noQuadro, conferencia.naSprint),
  }
}
