// Fase 4.2: a missão do PO reescrevendo tarefas fora do padrão.
//
// A 4.1 (conferência na varredura do retrato) marca em `repo_items.conferencia`
// as tarefas que não seguem os 8 campos. Aqui, dentro da missão do PO (o motor
// de IA só existe dentro de uma missão), o PO reescreve algumas delas. O motor
// só preenche o formulário; quem confere as travas, valida e escreve é
// `aplicar-ajuste-de-tarefa.ts`.
//
// Freios que mantêm a conta de chamadas e de motor baixa:
//  - no máximo 3 tarefas reescritas por missão (cada uma custa de 1 a 3
//    chamadas ao motor, pelo reparo do formulário);
//  - o laço para de abrir candidata depois de 8 leituras de tarefa por missão
//    (as que as travas barram custam uma leitura e não consomem motor). A
//    última candidata pode passar do teto: as travas leem a tarefa na escolha
//    e de novo na escrita, e um erro no PATCH pede mais uma releitura — no pior
//    caso são 10 leituras;
//  - a mesma tarefa com o mesmo texto não é tentada de novo (o rastro está na
//    própria conferência);
//  - as escritas saem em série, com pelo menos 1 s entre elas;
//  - o freio de cota do GitHub pula a missão inteira.
// Prioridade: tarefas na sprint e as que alguém já tem na mão vêm primeiro.

import type { PrismaClient } from '@prisma/client'
import type { InfraIssueForm } from '@gitorch/cadence'
import { DOD_FIELD_MAP } from '@gitorch/cadence'
import {
  ajusteDeTarefaLigado,
  avaliarSePodeReescrever,
  desfazerAjusteDeTarefa,
  reescreverTarefa,
  type AlvoDoDesfazer,
  type DepsDoAplicador,
  type DepsDoDesfazer,
  type IssueNoGitHub,
} from './aplicar-ajuste-de-tarefa.js'
import { ajustarTarefaForaDoPadrao } from './ajustar-tarefa-fora-do-padrao.js'
import { mesclarConferenciaDoItem } from './ficha-do-item.js'
import { ErroDoGitHub } from './erro-do-github.js'
import { donoDoRepositorio, freioDeCotaAtivo } from './freio-de-cota-do-github.js'
import { registrarNoPainelUmaVez } from './registro-no-painel.js'
import type { StepExecutor } from './role-rails.js'
import { cortarPorPontoDeCodigo } from './texto-seguro.js'

export const TETO_DE_AJUSTES_POR_MISSAO = 3
/** Leituras depois das quais o laço não abre outra candidata (o pior caso real é 10: ver o cabeçalho). */
export const TETO_DE_LEITURAS_POR_MISSAO = 8
export const PAUSA_ENTRE_ESCRITAS_MS = 1000

/** Falhas de escrita no mesmo texto antes de a tarefa deixar de ser tentada. */
const MAX_FALHAS_POR_TEXTO = 2

export interface CandidataAoAjuste {
  numero: number
  /** O que a 4.1 gravou (e o que o ajuste anterior deixou) em `repo_items.conferencia`. */
  conferencia: Record<string, unknown>
}

export interface DepsDoAjusteDoPo extends DepsDoAplicador {
  /** As fichas de tarefa abertas com `conferencia.padraoOk = false`. */
  listarCandidatas: () => Promise<CandidataAoAjuste[]>
  /** O motor preenche o formulário; devolve `{ erroDeValidacao }` se nunca validou e LANÇA se o motor falhou. */
  ajustarComOMotor: (args: {
    numero: number
    titulo: string
    corpo: string
    conferencia: Record<string, unknown>
  }) => Promise<InfraIssueForm | { erroDeValidacao: string }>
  /** Injetável em teste. */
  esperar?: (ms: number) => Promise<void>
  /** `true` pula a missão: o GitHub está em freio de cota para o dono do repositório. */
  freioDeCotaAtivo?: () => boolean
  info?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

export interface ResultadoDoAjusteDoPo {
  aplicadas: number[]
  invalidas: number[]
  falhas: number[]
  bloqueadas: Array<{ numero: number; motivo: string }>
  /** Escrita com erro cujo resultado no GitHub não deu para confirmar (pede conferência). */
  incertas: number[]
  puladoPor?: 'interruptor' | 'autonomia' | 'freio-de-cota'
}

function vazio(puladoPor?: ResultadoDoAjusteDoPo['puladoPor']): ResultadoDoAjusteDoPo {
  return {
    aplicadas: [],
    invalidas: [],
    falhas: [],
    bloqueadas: [],
    incertas: [],
    ...(puladoPor ? { puladoPor } : {}),
  }
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null
}

/** Esta tarefa, com este texto, já teve a sua vez (ou falhou vezes demais)? */
function jaTentadaComEsteTexto(conferencia: Record<string, unknown>): boolean {
  const ajuste = objeto(conferencia['ajuste'])
  if (!ajuste || ajuste['hashDoCorpoOriginal'] !== conferencia['hashDoCorpo']) return false
  if (ajuste['estado'] === 'falhou') {
    return typeof ajuste['falhas'] === 'number' && ajuste['falhas'] >= MAX_FALHAS_POR_TEXTO
  }
  return true
}

function falhasAnteriores(conferencia: Record<string, unknown>): number {
  const ajuste = objeto(conferencia['ajuste'])
  if (!ajuste || ajuste['hashDoCorpoOriginal'] !== conferencia['hashDoCorpo']) return 0
  return typeof ajuste['falhas'] === 'number' ? ajuste['falhas'] : 0
}

function temPrioridade(c: CandidataAoAjuste): boolean {
  return c.conferencia['naSprint'] === true || c.conferencia['emExecucao'] === true
}

function nomeDoCampo(chave: string): string {
  if (chave === 'titulo') return 'Título'
  return DOD_FIELD_MAP.find((c) => c.key === chave)?.header ?? chave
}

function motivoDoAjuste(conferencia: Record<string, unknown>): string {
  const faltando = Array.isArray(conferencia['camposFaltando'])
    ? (conferencia['camposFaltando'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  return faltando.length > 0
    ? `faltavam os campos: ${faltando.map(nomeDoCampo).join(', ')}`
    : 'a tarefa não seguia o padrão de 8 campos'
}

function issueFoiApagada(err: unknown): boolean {
  return err instanceof ErroDoGitHub && (err.status === 404 || err.status === 410)
}

/**
 * A missão: escolhe as tarefas, pede o formulário ao motor e entrega ao
 * aplicador. Lança quando o MOTOR falha (quem chamou decide o que fazer; nada
 * é marcado como tentado) ou quando o GitHub falha de um jeito que não é
 * "a tarefa sumiu".
 */
export async function rodarAjusteDeTarefasForaDoPadrao(
  deps: DepsDoAjusteDoPo
): Promise<ResultadoDoAjusteDoPo> {
  if (!deps.interruptorLigado()) return vazio('interruptor')
  if (deps.autonomia() !== 'cuidar') return vazio('autonomia')
  if (deps.freioDeCotaAtivo?.()) {
    deps.info?.(`ajuste de tarefas de ${deps.repo}: GitHub em freio de cota; pulando esta missão`)
    return vazio('freio-de-cota')
  }

  const candidatas = (await deps.listarCandidatas())
    .filter(
      (c) =>
        c.conferencia['padraoOk'] === false &&
        typeof c.conferencia['hashDoCorpo'] === 'string' &&
        !jaTentadaComEsteTexto(c.conferencia)
    )
    .sort((a, b) => {
      const pa = temPrioridade(a) ? 0 : 1
      const pb = temPrioridade(b) ? 0 : 1
      return pa - pb || a.numero - b.numero
    })

  const resultado = vazio()
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let leituras = 0
  let tentativas = 0
  let escritasFeitas = 0

  // O aplicador enxerga o mesmo `deps`, mas as leituras são contadas e as
  // escritas ganham a pausa de pelo menos 1 s entre uma e outra.
  const doAplicador: DepsDoAplicador = {
    ...deps,
    lerIssue: async (numero) => {
      leituras += 1
      return deps.lerIssue(numero)
    },
    escreverIssue: async (numero, dados) => {
      if (escritasFeitas > 0) await esperar(PAUSA_ENTRE_ESCRITAS_MS)
      escritasFeitas += 1
      await deps.escreverIssue(numero, dados)
    },
  }

  for (const candidata of candidatas) {
    if (tentativas >= TETO_DE_AJUSTES_POR_MISSAO || leituras >= TETO_DE_LEITURAS_POR_MISSAO) break
    const hash = candidata.conferencia['hashDoCorpo'] as string

    let trava: Awaited<ReturnType<typeof avaliarSePodeReescrever>>
    try {
      trava = await avaliarSePodeReescrever(doAplicador, {
        numero: candidata.numero,
        hashDoCorpoConferido: hash,
      })
    } catch (err) {
      if (!issueFoiApagada(err)) throw err
      resultado.bloqueadas.push({ numero: candidata.numero, motivo: 'a tarefa não existe mais' })
      continue
    }
    if (!trava.pode) {
      resultado.bloqueadas.push({ numero: candidata.numero, motivo: trava.motivo })
      continue
    }

    tentativas += 1
    const motivo = motivoDoAjuste(candidata.conferencia)
    const form = await deps.ajustarComOMotor({
      numero: candidata.numero,
      titulo: trava.issue.titulo,
      corpo: trava.issue.corpo,
      conferencia: candidata.conferencia,
    })

    if ('erroDeValidacao' in form) {
      await deps.gravarConferencia(candidata.numero, {
        ajuste: {
          estado: 'invalido',
          hashDoCorpoOriginal: hash,
          motivo: cortarPorPontoDeCodigo(
            `o motor não devolveu um formulário válido: ${form.erroDeValidacao}`,
            300
          ),
          tentadoEm: (deps.agora ?? (() => new Date()))().toISOString(),
        },
      })
      await deps.registrarNoPainel({
        chave: `ajuste:${deps.repo}:${candidata.numero}:${hash}:invalido`,
        texto:
          `GitOrch: não reescrevi a tarefa #${candidata.numero} de ${deps.repo} — o motor não ` +
          `devolveu um formulário válido. Nada foi alterado no GitHub. ` +
          `https://github.com/${deps.repo}/issues/${candidata.numero}`,
      })
      resultado.invalidas.push(candidata.numero)
      continue
    }

    const r = await reescreverTarefa(doAplicador, {
      numero: candidata.numero,
      hashDoCorpoConferido: hash,
      form,
      motivo,
      falhasAnteriores: falhasAnteriores(candidata.conferencia),
    })
    if (r.tipo === 'aplicado') resultado.aplicadas.push(candidata.numero)
    else if (r.tipo === 'invalido') resultado.invalidas.push(candidata.numero)
    else if (r.tipo === 'bloqueado') {
      resultado.bloqueadas.push({ numero: candidata.numero, motivo: r.motivo })
    } else if (r.tipo === 'incerto') {
      // Sem saber o que está no GitHub, mexer em outra tarefa só piora a confusão.
      resultado.incertas.push(candidata.numero)
      deps.onWarn?.(
        `ajuste de tarefas de ${deps.repo}: não consegui confirmar a escrita na tarefa #${candidata.numero} (${r.motivo}); parando esta missão`
      )
      break
    } else {
      // Escrita recusada: parar aqui evita repetir o mesmo erro nas próximas.
      resultado.falhas.push(candidata.numero)
      deps.onWarn?.(
        `ajuste de tarefas de ${deps.repo}: a escrita na tarefa #${candidata.numero} falhou (${r.motivo}); parando esta missão`
      )
      break
    }
  }

  if (resultado.aplicadas.length > 0) {
    deps.info?.(
      `ajuste de tarefas de ${deps.repo}: reescrevi ${resultado.aplicadas.map((n) => `#${n}`).join(', ')}`
    )
  }
  return resultado
}

// ---------------------------------------------------------------------------
// Ligação ao banco e ao GitHub (o que o scheduler monta)
// ---------------------------------------------------------------------------

type PrismaDoAjuste = Pick<PrismaClient, 'repoItem' | 'devSession' | 'event'>
type LerDoGitHub = (caminho: string) => Promise<unknown>
type EscreverNoGitHub = (metodo: 'PATCH', caminho: string, corpo: unknown) => Promise<unknown>

function issueDoGitHub(bruto: unknown): IssueNoGitHub {
  const i = objeto(bruto) ?? {}
  const etiquetas = Array.isArray(i['labels'])
    ? (i['labels'] as unknown[]).flatMap((l) => {
        const nome = typeof l === 'string' ? l : objeto(l)?.['name']
        return typeof nome === 'string' ? [nome] : []
      })
    : []
  const atualizada = typeof i['updated_at'] === 'string' ? new Date(i['updated_at']) : null
  return {
    titulo: typeof i['title'] === 'string' ? i['title'] : '',
    corpo: typeof i['body'] === 'string' ? i['body'] : '',
    etiquetas,
    estado: typeof i['state'] === 'string' ? i['state'] : 'unknown',
    ehPullRequest: i['pull_request'] !== undefined && i['pull_request'] !== null,
    atualizadaEm: atualizada !== null && !Number.isNaN(atualizada.getTime()) ? atualizada : null,
  }
}

function portasDoGitHub(args: {
  repo: string
  ghGet: LerDoGitHub
  ghSend: EscreverNoGitHub
}): Pick<DepsDoAplicador, 'lerIssue' | 'escreverIssue'> {
  return {
    lerIssue: async (numero) =>
      issueDoGitHub(await args.ghGet(`/repos/${args.repo}/issues/${numero}`)),
    escreverIssue: async (numero, dados) => {
      await args.ghSend('PATCH', `/repos/${args.repo}/issues/${numero}`, {
        title: dados.titulo,
        body: dados.corpo,
      })
    },
  }
}

function portasDoBanco(args: {
  prisma: PrismaDoAjuste
  projectId: string
  agora: () => Date
}): Pick<DepsDoAplicador, 'gravarConferencia' | 'lerConferencia' | 'registrarNoPainel'> {
  return {
    lerConferencia: async (numero) => {
      const linha = await args.prisma.repoItem.findUnique({
        where: {
          projectId_tipo_numero: { projectId: args.projectId, tipo: 'issue', numero },
        },
        select: { conferencia: true },
      })
      return objeto(linha?.conferencia)
    },
    gravarConferencia: async (numero, parcial) => {
      const gravou = await mesclarConferenciaDoItem({
        prisma: args.prisma,
        projectId: args.projectId,
        tipo: 'issue',
        numero,
        parcial,
      })
      if (!gravou)
        throw new Error(`a ficha da tarefa #${numero} não existe ou não aceitou a gravação`)
    },
    registrarNoPainel: async (evento) => {
      await registrarNoPainelUmaVez({
        prisma: args.prisma,
        projectId: args.projectId,
        chave: evento.chave,
        texto: evento.texto,
      })
    },
  }
}

export async function rodarAjusteDoPoComPrisma(args: {
  prisma: PrismaDoAjuste
  project: { id: string; wingId: string; autonomia?: string | null }
  ghGet: LerDoGitHub
  ghSend: EscreverNoGitHub
  execute: StepExecutor
  contextBlocks: string[]
  /** Onde a variável do interruptor é lida; em produção, `process.env`. */
  env?: Record<string, string | undefined>
  agora?: () => Date
  esperar?: (ms: number) => Promise<void>
  info?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}): Promise<ResultadoDoAjusteDoPo> {
  const { prisma, project } = args
  const agora = args.agora ?? (() => new Date())

  return rodarAjusteDeTarefasForaDoPadrao({
    repo: project.wingId,
    autonomia: () => project.autonomia,
    interruptorLigado: () => ajusteDeTarefaLigado(args.env ?? process.env),
    ...portasDoGitHub({ repo: project.wingId, ghGet: args.ghGet, ghSend: args.ghSend }),
    ...portasDoBanco({ prisma, projectId: project.id, agora }),
    temSessaoDoDevViva: async (numero) =>
      (await prisma.devSession.findFirst({
        where: { projectId: project.id, issueNumber: numero, closedAt: null },
        select: { id: true },
      })) !== null,
    temEntregaEmJulgamento: async (numero) =>
      (await prisma.repoItem.findFirst({
        where: {
          projectId: project.id,
          tipo: 'pr',
          issueNumber: numero,
          OR: [
            { estado: { path: ['status'], equals: 'open' } },
            { parecerTravadoAte: { gt: agora() } },
          ],
        },
        select: { id: true },
      })) !== null,
    listarCandidatas: async () => {
      const linhas = await prisma.repoItem.findMany({
        where: {
          projectId: project.id,
          tipo: 'issue',
          AND: [
            { estado: { path: ['status'], equals: 'open' } },
            { conferencia: { path: ['padraoOk'], equals: false } },
          ],
        },
        select: { numero: true, conferencia: true },
      })
      return linhas.flatMap((l) => {
        const conferencia = objeto(l.conferencia)
        return conferencia ? [{ numero: l.numero, conferencia }] : []
      })
    },
    ajustarComOMotor: (a) =>
      ajustarTarefaForaDoPadrao({
        issueNumber: a.numero,
        repository: project.wingId,
        tituloOriginal: a.titulo,
        corpoOriginal: a.corpo,
        conferencia: {
          padraoOk: false,
          erros: Array.isArray(a.conferencia['erros'])
            ? (a.conferencia['erros'] as unknown[]).filter(
                (e): e is string => typeof e === 'string'
              )
            : [],
          peso: typeof a.conferencia['peso'] === 'number' ? a.conferencia['peso'] : null,
          noQuadro:
            typeof a.conferencia['estaNoQuadro'] === 'boolean'
              ? a.conferencia['estaNoQuadro']
              : null,
          naSprint:
            typeof a.conferencia['naSprint'] === 'boolean' ? a.conferencia['naSprint'] : null,
        },
        contextBlocks: args.contextBlocks,
        execute: args.execute,
      }),
    freioDeCotaAtivo: () => freioDeCotaAtivo(donoDoRepositorio(project.wingId), agora()),
    agora,
    ...(args.esperar ? { esperar: args.esperar } : {}),
    ...(args.info ? { info: args.info } : {}),
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
  })
}

/** Desfaz o ajuste de uma tarefa a partir da ficha: o caminho que o "como desfazer" do painel aponta. */
export async function desfazerAjusteDaTarefaDoProjeto(args: {
  prisma: PrismaDoAjuste
  projectId: string
  repo: string
  numero: number
  ghGet: LerDoGitHub
  ghSend: EscreverNoGitHub
  forcar?: boolean
  /** `original` (padrão): o primeiro texto, de antes do GitOrch. `anterior`: o texto imediatamente anterior à última reescrita. */
  alvo?: AlvoDoDesfazer
  agora?: () => Date
}): Promise<{ desfeito: true } | { desfeito: false; motivo: string }> {
  const agora = args.agora ?? (() => new Date())
  const deps: DepsDoDesfazer = {
    repo: args.repo,
    ...portasDoGitHub({ repo: args.repo, ghGet: args.ghGet, ghSend: args.ghSend }),
    ...portasDoBanco({ prisma: args.prisma, projectId: args.projectId, agora }),
    agora,
  }
  return desfazerAjusteDeTarefa(deps, {
    numero: args.numero,
    ...(args.forcar !== undefined ? { forcar: args.forcar } : {}),
    ...(args.alvo !== undefined ? { alvo: args.alvo } : {}),
  })
}
