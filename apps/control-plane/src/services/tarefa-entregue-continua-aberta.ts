/**
 * A tarefa fecha quando a entrega dela entra — não importa QUEM mesclou.
 *
 * DIAGNÓSTICO DO DONO, 27/08, e ele foi mais preciso que eu: "falta é o
 * gitorch saber todas issues do projeto e o que cada issue É e qual é linkado
 * a qual PR, pois já vi PRs merged com issue open".
 *
 * MEDIDO NO BANCO depois disso: dezesseis tarefas do gitorch e nove do
 * patinhas estavam ABERTAS com a entrega delas já mesclada — e o produto
 * SABIA, porque a linha da entrega tinha o commit do merge gravado. Algumas
 * foram redelegadas várias vezes por isso: a tarefa #128 chegou a ter CINCO
 * entregas, a #110 e a #210 três cada.
 *
 * POR QUE ACONTECIA: `fecharTarefaEntregue` só roda dentro da missão de QA,
 * logo depois de o produto mesclar com as próprias mãos. Quando o merge vinha
 * por outro caminho — o auto-merge do repositório, ou uma pessoa clicando —
 * ninguém fechava a tarefa. E tarefa aberta volta para a fila do gerente, que
 * a delega de novo, e a entrega nova nasce em conflito com a que já entrou.
 *
 * O conserto não é uma regra nova de fechamento: é a MESMA regra
 * (`decidirFechamento`, fechar-tarefa.ts) aplicada também fora do caminho em
 * que o produto foi o autor do merge. Este arquivo só decide QUEM merece ser
 * conferido, para a varredura não perguntar o estado de tarefa nenhuma à toa.
 *
 * O que ela FAZ com a tarefa aberta segue a autonomia do projeto: `cuidar`
 * encerra com registro; `sugerir` não escreve no GitHub e pergunta ao dono pelo
 * painel e Telegram (só aquela tarefa espera); `so_olhar` só registra no painel.
 * Nada é publicado na issue esperando que alguém aja: o dono não acompanha o
 * GitHub.
 */

import { normalizarNivel } from '@gitorch/cadence'
import type { AgentQuestionOption } from './agent-question.js'
import { corpoDoRegistroDeEntrega, textoDoRegistroDeEntrega } from './registro-de-entrega.js'
import {
  RESPOSTA_FECHAR_A_TAREFA,
  RESPOSTA_SEGUIR_COM_A_TAREFA,
  dedupKeyDaSuspeita,
} from './suspeita-de-tarefa-resolvida.js'
import { buildFreeTextOption } from './telegram-bot.js'

export interface EntregaParaConferir {
  projectId: string
  issueNumber: number
  pullRequestNumber: number | null
  mergeCommitSha: string | null
  closedReason?: string | null | undefined
  /** Quando a entrega foi encerrada (o merge); a ordem dos PRs citados sai daqui. */
  closedAt?: Date | null | undefined
  /** Última escrita na linha da entrega — de onde sai a carência abaixo. */
  updatedAt: Date
}

/** A identidade de uma tarefa: o número só vale dentro do projeto dela. */
export function chaveDaTarefa(projectId: string, issueNumber: number): string {
  return `${projectId}#${issueNumber}`
}

/**
 * Quanto tempo a varredura espera antes de encostar numa entrega.
 *
 * O caminho normal (a missão de QA que acabou de mesclar) fecha a tarefa em
 * segundos. Se a varredura agisse junto, as DUAS comentariam e fechariam a
 * mesma tarefa — dois comentários idênticos no repositório do cliente, que é
 * exatamente o ruído que este produto evita em todo lugar. Um teste de costura
 * real pegou isso antes de ir para produção.
 *
 * Meia hora: muito além do que o caminho normal precisa, e muito aquém de
 * deixar a tarefa aberta tempo suficiente para o gerente redelegá-la.
 */
export const CARENCIA_ANTES_DE_VARRER_MS = 30 * 60_000

/**
 * Quantas tarefas a varredura consulta por passada. Cada consulta leva cerca
 * de 0,3 s; quarenta cabem com folga em meia dezena de segundos e a fila
 * andando em rodízio esgota o estoque em poucas passadas.
 */
export const TETO_DE_TAREFAS_POR_PASSADA = 40

/** Quanto tempo uma tarefa que não deu para ler descansa antes de nova tentativa. */
export const ESPERA_APOS_FALHA_MS = 6 * 60 * 60_000

/**
 * As entregas que valem uma consulta ao GitHub.
 *
 * Sem commit de merge não há o que fechar. Sem número de tarefa não há o que
 * fechar. Recém-mesclada também não entra: aquela ainda é do caminho normal.
 *
 * A mesma tarefa (projeto + número) aparece uma vez só, por mais entregas que
 * tenha acumulado — foi justamente a redelegação repetida que encheu o quadro.
 * A chave inclui o projeto: o número da issue só é único dentro de um
 * repositório, e deduplicar só por número fazia a tarefa de um projeto sumir
 * atrás da homônima de outro.
 */
export function entregasQueMerecemConferencia<T extends EntregaParaConferir>(
  linhas: readonly T[],
  agora: Date = new Date()
): T[] {
  const vistas = new Set<string>()
  const escolhidas: T[] = []
  for (const linha of linhas) {
    if (!linha.mergeCommitSha && linha.closedReason !== 'merged') continue
    if (!Number.isInteger(linha.issueNumber) || linha.issueNumber <= 0) continue
    // Recém-mesclada é do caminho normal, não desta varredura.
    if (agora.getTime() - linha.updatedAt.getTime() < CARENCIA_ANTES_DE_VARRER_MS) continue
    const chave = chaveDaTarefa(linha.projectId, linha.issueNumber)
    if (vistas.has(chave)) continue
    vistas.add(chave)
    escolhidas.push(linha)
  }
  return escolhidas
}

/** O que a ficha da tarefa já sabe sobre ela. */
export interface FichaDaTarefa {
  status: string | null
  /** O produto fechou esta tarefa por causa da entrega (guardado na conferência). */
  fechadaPelaEntrega: boolean
  /** A decisão guardada sobre a suspeita/entrega desta tarefa, quando houve. */
  memoria?: {
    veredito: string
    avaliadaEm?: string
    /** `dono`: foi a resposta dele ("ainda falta fazer"), não uma avaliação do produto. */
    origem?: string
  }
}

/** Quanto tempo uma pergunta ou registro já feitos descansam antes de a tarefa ser reavaliada. */
export const DESCANSO_DA_DECISAO_MS = 24 * 60 * 60_000

/** O que a varredura precisa do projeto: o repositório e as chamadas que faz nele. */
export interface ContextoDoProjeto {
  wingId: string
  /** Até onde o produto pode ir neste repositório. */
  autonomia: string | null | undefined
  lerIssue: (numero: number) => Promise<{
    state?: string
    title?: string
    updated_at?: string
    body?: string | null
  }>
  /** O registro do produto já está nos comentários desta tarefa? */
  jaTemRegistro: (numero: number) => Promise<boolean>
  comentar: (numero: number, corpo: string) => Promise<void>
  fechar: (numero: number) => Promise<void>
  /** Pergunta ao dono por painel e Telegram; só esta tarefa espera. */
  perguntar: (p: {
    text: string
    options: AgentQuestionOption[]
    dedupKey: string
  }) => Promise<void>
  perguntaAberta: (dedupKey: string) => Promise<boolean>
}

export interface DepsDaVarredura {
  linhas: readonly EntregaParaConferir[]
  agora: Date
  teto?: number
  /** Ficha de cada tarefa, por `chaveDaTarefa`. Ausente = nunca vista. */
  fichas: ReadonlyMap<string, FichaDaTarefa>
  /** Até quando cada tarefa que falhou descansa. Vive no processo e é mutada aqui. */
  falhasAte: Map<string, number>
  /** `null` pula o projeto (inativo, sem credencial, cota em freio) sem gastar vaga do teto. */
  abrirProjeto: (projectId: string) => Promise<ContextoDoProjeto | null>
  /** Grava na ficha que a tarefa está fechada (e se fomos nós). */
  marcarFicha: (
    projectId: string,
    numero: number,
    quem: { fechadaPelaEntrega: boolean }
  ) => Promise<void>
  /** Guarda na ficha que a tarefa foi perguntada ou registrada (não se repete antes do descanso). */
  gravarMemoria: (
    projectId: string,
    numero: number,
    memoria: { veredito: 'perguntada' | 'registrada'; issueAtualizadaEm: string }
  ) => Promise<void>
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  /** Depois de uma falha: `true` para o projeto parar (cota esgotada). */
  aposFalha: (wingId: string) => boolean
  /** A guarda de autonomia recusou a escrita neste projeto. */
  naoAutorizado: (err: unknown) => boolean
  aviso: (mensagem: string) => void
  info: (mensagem: string) => void
}

export interface ResumoDaVarredura {
  candidatas: number
  consultadas: number
  fechadas: number
  falhas: number
}

/**
 * Quem pode entrar na passada, nesta ordem de prioridade (sem teto: o teto vale
 * só para o que for de fato consultado, projeto a projeto, em `varrer…`).
 *
 *  - Fora: tarefa que a ficha já diz fechada (consultar de novo não muda nada),
 *    tarefa que o produto fechou e alguém reabriu (reabrir é decisão de gente),
 *    tarefa que o dono mandou seguir, tarefa perguntada ou registrada há pouco
 *    e tarefa que falhou há pouco (repetir a mesma leitura só gasta cota).
 *  - Primeiro quem nunca falhou; depois, quem falhou há mais tempo.
 */
export function elegiveisDaPassada<T extends EntregaParaConferir>(args: {
  candidatas: readonly T[]
  fichas: ReadonlyMap<string, FichaDaTarefa>
  falhasAte: ReadonlyMap<string, number>
  agora: Date
}): T[] {
  const agoraMs = args.agora.getTime()
  const elegiveis = args.candidatas.filter((l) => {
    const chave = chaveDaTarefa(l.projectId, l.issueNumber)
    const ficha = args.fichas.get(chave)
    if (ficha?.status === 'closed') return false
    if (ficha?.fechadaPelaEntrega) return false
    const memoria = ficha?.memoria
    if (memoria?.veredito === 'descartada' && memoria.origem === 'dono') return false
    if (memoria?.veredito === 'perguntada' || memoria?.veredito === 'registrada') {
      const quando = Date.parse(memoria.avaliadaEm ?? '')
      if (Number.isFinite(quando) && agoraMs - quando < DESCANSO_DA_DECISAO_MS) return false
    }
    const descansaAte = args.falhasAte.get(chave)
    return descansaAte === undefined || descansaAte <= agoraMs
  })
  const ultimaFalha = (l: T): number =>
    args.falhasAte.get(chaveDaTarefa(l.projectId, l.issueNumber)) ?? 0
  // `sort` é estável: dentro do mesmo grupo vale a ordem de chegada.
  return [...elegiveis].sort((a, b) => ultimaFalha(a) - ultimaFalha(b))
}

/**
 * Os PRs mesclados desta tarefa, do mais antigo ao mais novo. Vêm de TODAS as
 * linhas de entrega dela (a tarefa pode ter tido várias), não só da escolhida.
 */
export function prsMescladosDaTarefa(
  linhas: readonly EntregaParaConferir[],
  projectId: string,
  issueNumber: number
): number[] {
  const quando = (l: EntregaParaConferir): number => (l.closedAt ?? l.updatedAt).getTime()
  const daTarefa = linhas
    .filter(
      (l) =>
        l.projectId === projectId &&
        l.issueNumber === issueNumber &&
        l.pullRequestNumber !== null &&
        (l.mergeCommitSha || l.closedReason === 'merged')
    )
    .sort((a, b) => quando(a) - quando(b))
  return [...new Set(daTarefa.map((l) => l.pullRequestNumber as number))]
}

function nomeDasEntregas(prs: readonly number[]): string {
  if (prs.length === 0) return 'a entrega'
  if (prs.length === 1) return `o PR #${prs[0]}`
  const ultimo = prs[prs.length - 1]
  return `os PRs ${prs
    .slice(0, -1)
    .map((n) => `#${n}`)
    .join(', ')} e #${ultimo}`
}

/** A pergunta ao dono (nível `sugerir`); a resposta cai no mesmo tratador da suspeita. */
export function montarPerguntaDaEntrega(args: {
  repositorio: string
  numero: number
  titulo: string
  issueAtualizadaEm: string
  prs: readonly number[]
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const titulo = args.titulo.replace(/\s+/g, ' ').trim().slice(0, 80)
  return {
    text: [
      `A tarefa #${args.numero} de ${args.repositorio}${titulo ? ` ("${titulo}")` : ''} continua aberta, mas ${nomeDasEntregas(args.prs)} que a resolve já foi mesclado.`,
      'Só esta tarefa fica esperando a sua resposta; as outras seguem. Fecho a tarefa como entregue ou ela ainda falta?',
    ].join('\n\n'),
    options: [
      { label: 'Já está entregue: fechar a tarefa', value: RESPOSTA_FECHAR_A_TAREFA },
      { label: 'Ainda falta fazer: seguir com a tarefa', value: RESPOSTA_SEGUIR_COM_A_TAREFA },
      buildFreeTextOption(),
    ],
    dedupKey: dedupKeyDaSuspeita(args.repositorio, args.numero, args.issueAtualizadaEm),
  }
}

/**
 * Confere as tarefas entregues, cada uma no repositório do SEU projeto, e age
 * nas que ainda estão abertas conforme a autonomia do projeto. Devolve os
 * números da passada para o log.
 */
export async function varrerTarefasEntregues(deps: DepsDaVarredura): Promise<ResumoDaVarredura> {
  const candidatas = entregasQueMerecemConferencia(deps.linhas, deps.agora)
  const elegiveis = elegiveisDaPassada({
    candidatas,
    fichas: deps.fichas,
    falhasAte: deps.falhasAte,
    agora: deps.agora,
  })
  const resumo: ResumoDaVarredura = {
    candidatas: candidatas.length,
    consultadas: 0,
    fechadas: 0,
    falhas: 0,
  }

  const porProjeto = new Map<string, typeof elegiveis>()
  for (const e of elegiveis) {
    const lista = porProjeto.get(e.projectId) ?? []
    lista.push(e)
    porProjeto.set(e.projectId, lista)
  }

  // O teto conta só o que foi de fato consultado: projeto pulado (inativo, sem
  // credencial, em freio de cota) não gasta vaga nem segura a vez dos outros.
  let vagas = deps.teto ?? TETO_DE_TAREFAS_POR_PASSADA
  for (const [projectId, entregas] of porProjeto) {
    if (vagas <= 0) break
    const ctx = await deps.abrirProjeto(projectId)
    if (!ctx) continue
    const nivel = normalizarNivel(ctx.autonomia)

    for (const entrega of entregas.slice(0, vagas)) {
      const numero = entrega.issueNumber
      vagas -= 1
      resumo.consultadas += 1
      try {
        const issue = await ctx.lerIssue(numero)
        if (issue.state !== 'open') {
          await deps.marcarFicha(projectId, numero, { fechadaPelaEntrega: false })
          continue
        }

        const prs = prsMescladosDaTarefa(deps.linhas, projectId, numero)
        const issueAtualizadaEm = issue.updated_at ?? ''

        if (nivel === 'so_olhar') {
          await deps
            .registrarNoPainel(
              projectId,
              `tarefa-entregue-so-olhar:${ctx.wingId}#${numero}`,
              `Tarefa #${numero} de ${ctx.wingId} continua aberta, mas ${nomeDasEntregas(prs)} que a resolve já foi mesclado. O projeto está em "só olhar", então nada foi alterado.`
            )
            .catch((err) =>
              deps.aviso(
                `${ctx.wingId}: registro no painel da tarefa #${numero} falhou: ${(err as Error).message}`
              )
            )
          await guardarMemoria(deps, ctx.wingId, projectId, numero, 'registrada', issueAtualizadaEm)
          continue
        }

        if (nivel === 'sugerir') {
          // Sugerir não escreve no GitHub: nem comentário, nem fechamento.
          const pergunta = montarPerguntaDaEntrega({
            repositorio: ctx.wingId,
            numero,
            titulo: issue.title ?? '',
            issueAtualizadaEm,
            prs,
          })
          if (!(await ctx.perguntaAberta(pergunta.dedupKey))) await ctx.perguntar(pergunta)
          await guardarMemoria(deps, ctx.wingId, projectId, numero, 'perguntada', issueAtualizadaEm)
          continue
        }

        // cuidar: primeiro o fechamento, depois o registro. Se o fechamento
        // falhar, nada foi publicado e a passada seguinte não repete comentário.
        await ctx.fechar(numero)
        try {
          if (!(await ctx.jaTemRegistro(numero))) {
            await ctx.comentar(numero, corpoDoRegistroDeEntrega(prs))
          }
        } catch (err) {
          if (deps.naoAutorizado(err)) throw err
          deps.aviso(
            `${ctx.wingId}: tarefa #${numero} encerrada, mas o registro na issue falhou: ${(err as Error).message}`
          )
        }
        await deps.marcarFicha(projectId, numero, { fechadaPelaEntrega: true })
        resumo.fechadas += 1
        await deps
          .registrarNoPainel(
            projectId,
            `tarefa-entregue-fechada:${ctx.wingId}#${numero}`,
            `Tarefa #${numero} de ${ctx.wingId} encerrada. ${textoDoRegistroDeEntrega(prs)}`
          )
          .catch((err) =>
            deps.aviso(
              `${ctx.wingId}: tarefa #${numero} encerrada, mas o registro no painel falhou: ${(err as Error).message}`
            )
          )
        deps.info(`${ctx.wingId}: tarefa #${numero} encerrada — a entrega dela já estava mesclada`)
      } catch (err) {
        if (deps.naoAutorizado(err)) {
          // A guarda de autonomia deste projeto não deixa escrever: não é falha.
          deps.info(`${ctx.wingId}: autonomia não permite encerrar tarefas; pulando o projeto`)
          break
        }
        // Uma tarefa apagada ou sem permissão não pode deixar as outras abertas
        // para sempre — nem ser relida a cada passada.
        deps.falhasAte.set(
          chaveDaTarefa(projectId, numero),
          deps.agora.getTime() + ESPERA_APOS_FALHA_MS
        )
        resumo.falhas += 1
        deps.aviso(
          `${ctx.wingId}: não consegui conferir a tarefa #${numero}: ${(err as Error).message}`
        )
        // Limite de taxa: insistir nas outras tarefas só gasta mais cota.
        if (deps.aposFalha(ctx.wingId)) break
      }
    }
  }
  return resumo
}

async function guardarMemoria(
  deps: DepsDaVarredura,
  wingId: string,
  projectId: string,
  numero: number,
  veredito: 'perguntada' | 'registrada',
  issueAtualizadaEm: string
): Promise<void> {
  await deps
    .gravarMemoria(projectId, numero, { veredito, issueAtualizadaEm })
    .catch((err) =>
      deps.aviso(
        `${wingId}: tarefa #${numero} decidida, mas não consegui guardar na ficha: ${(err as Error).message}`
      )
    )
}
