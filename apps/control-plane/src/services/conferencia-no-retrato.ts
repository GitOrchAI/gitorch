// Fase 4.1: a conferência das tarefas dentro da varredura do retrato.
//
// A cada passada de 30 min por projeto, cada issue aberta que é tarefa (tem a
// etiqueta de tarefa ou está no quadro) é conferida contra o padrão dos 8
// campos, o peso e a presença no quadro e na sprint. Nada aqui usa motor de
// IA, e a única leitura nova é a do quadro (uma por ciclo, compartilhada por
// cache em memória com a conta do custo da ordem). O resultado vai para
// `repo_items.conferencia`, nunca para `estado` (a varredura troca o `estado`
// inteiro a cada passada e apagaria o que fosse derivado).
//
// Só regrava quando algo mudou: o texto da tarefa (título ou corpo) ou o que o
// quadro diz dela. O evento de painel sai só quando o RESULTADO muda (o
// conjunto de erros, ou a volta ao padrão), com chave estável — repetir a
// passada não repete o aviso.

import type { PrismaClient } from '@prisma/client'
import { DOD_FIELD_MAP } from '@gitorch/cadence'
import { ProjectV2Client } from '@gitorch/github-sync'
import {
  conferirTarefaSemPedido,
  estadoDoQuadroDaConferencia,
  hashDoCorpoDaTarefa,
  montarConferenciaGravada,
  type ConferenciaGravada,
} from './conferir-tarefa-sem-pedido.js'
import { mesclarConferenciaDoItem } from './ficha-do-item.js'
import { registrarNoPainelUmaVez } from './registro-no-painel.js'
import {
  lerQuadroComCache,
  lerQuadroCompleto,
  type LeituraDoQuadro,
} from './leitura-do-quadro-em-cache.js'
import { ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA } from './sprint-com-itens.js'

/** A etiqueta que o PO põe em toda tarefa de execução que cria. */
export const ETIQUETA_DE_TAREFA = 'gitorch:task'

/** Etiquetas de issues que nunca são tarefa de execução: pedido do dono, incidente, proposta. */
const ETIQUETAS_QUE_NAO_SAO_TAREFA: ReadonlySet<string> = new Set([
  'wishlist',
  'gitorch:incident',
  'gitorch:proposal',
])

/** Fase, épico e feature são agrupadores: o corpo deles não tem (nem deve ter) os 8 campos. */
const MARCADOR_DE_AGRUPADOR = /gitorch:node:\d+:(?:phase|epic|feature):\d+/

export interface IssueParaConferir {
  numero: number
  titulo: string
  corpo: string
  etiquetas: string[]
}

/** O que o quadro diz, já no formato que a conferência usa. */
export interface QuadroParaConferir {
  itens: ReadonlyMap<number, { iteracaoId: string | null }>
  /** A sprint que corre hoje; `null` = não se sabe. */
  iteracaoCorrenteId: string | null
  /** A leitura foi cortada: quem não está na lista pode estar no quadro. */
  truncado: boolean
}

export interface DepsDoConferidor {
  /** `dono/repo`. */
  repo: string
  /** Lê o quadro (com cache); `null` = não deu (sem quadro, sem credencial, freio de cota). */
  lerQuadro: () => Promise<QuadroParaConferir | null>
  /** A conferência já gravada de cada issue do projeto (lida UMA vez por ciclo). */
  lerConferenciasAnteriores: () => Promise<Map<number, Record<string, unknown> | null>>
  gravarConferencia: (numero: number, conferencia: ConferenciaGravada) => Promise<void>
  registrarNoPainel: (evento: { chave: string; texto: string }) => Promise<void>
  agora?: () => Date
  onWarn?: (mensagem: string) => void
}

function naoEhTarefaDeExecucao(issue: IssueParaConferir): boolean {
  if (issue.etiquetas.some((e) => ETIQUETAS_QUE_NAO_SAO_TAREFA.has(e))) return true
  return MARCADOR_DE_AGRUPADOR.test(issue.corpo)
}

function nomeDoCampo(chave: string): string {
  if (chave === 'titulo') return 'Título'
  return DOD_FIELD_MAP.find((c) => c.key === chave)?.header ?? chave
}

function lerBooleano(valor: unknown): boolean | null {
  return typeof valor === 'boolean' ? valor : null
}

function textoDoEvento(repo: string, numero: number, g: ConferenciaGravada): string {
  const link = `https://github.com/${repo}/issues/${numero}`
  if (g.padraoOk) {
    return `GitOrch: a tarefa #${numero} de ${repo} passou a seguir o padrão de 8 campos. ${link}`
  }
  const faltando = g.camposFaltando.map(nomeDoCampo).join(', ')
  return `GitOrch: a tarefa #${numero} de ${repo} não segue o padrão de 8 campos (falta: ${faltando}). ${link}`
}

/**
 * Cria o gancho que a varredura chama para cada issue aberta. O quadro e as
 * conferências anteriores são lidos sob demanda e UMA vez por ciclo (um
 * conferidor novo por ciclo, como a varredura monta os outros ganchos).
 */
export function criarConferidorDeTarefa(
  deps: DepsDoConferidor
): (issue: IssueParaConferir) => Promise<void> {
  const agora = deps.agora ?? (() => new Date())
  let quadroLido: Promise<QuadroParaConferir | null> | null = null
  let anteriores: Promise<Map<number, Record<string, unknown> | null>> | null = null

  const quadro = (): Promise<QuadroParaConferir | null> => {
    quadroLido ??= deps.lerQuadro().catch((err: unknown) => {
      deps.onWarn?.(`conferência: não consegui ler o quadro de ${deps.repo}: ${String(err)}`)
      return null
    })
    return quadroLido
  }
  const conferenciasAnteriores = (): Promise<Map<number, Record<string, unknown> | null>> => {
    anteriores ??= deps.lerConferenciasAnteriores()
    return anteriores
  }

  return async (issue) => {
    if (naoEhTarefaDeExecucao(issue)) return

    const q = await quadro()
    const itemDoQuadro = q?.itens.get(issue.numero)
    const temEtiquetaDeTarefa = issue.etiquetas.includes(ETIQUETA_DE_TAREFA)
    // Sem a etiqueta, só o quadro prova que a issue é uma tarefa.
    if (!temEtiquetaDeTarefa && !itemDoQuadro) return

    const antes = (await conferenciasAnteriores()).get(issue.numero) ?? null

    let estaNoQuadro: boolean | null
    let naSprint: boolean | null
    if (q && itemDoQuadro) {
      estaNoQuadro = true
      naSprint =
        q.iteracaoCorrenteId === null ? null : itemDoQuadro.iteracaoId === q.iteracaoCorrenteId
    } else if (q && !q.truncado) {
      estaNoQuadro = false
      naSprint = false
    } else if (q) {
      // Lista cortada: quem não apareceu pode estar no quadro, não se sabe.
      estaNoQuadro = null
      naSprint = null
    } else {
      // Quadro ilegível nesta passada: não apaga o que já se sabia dele.
      estaNoQuadro = lerBooleano(antes?.['estaNoQuadro'])
      naSprint = lerBooleano(antes?.['naSprint'])
    }

    const hashDoCorpo = hashDoCorpoDaTarefa(issue.titulo, issue.corpo)
    const estadoDoQuadro = estadoDoQuadroDaConferencia(estaNoQuadro, naSprint)
    if (
      antes &&
      antes['hashDoCorpo'] === hashDoCorpo &&
      antes['estadoDoQuadro'] === estadoDoQuadro
    ) {
      return
    }

    const gravada = montarConferenciaGravada({
      conferencia: conferirTarefaSemPedido({
        titulo: issue.titulo,
        corpo: issue.corpo,
        estaNoQuadro,
        estaNaSprintAtual: naSprint,
      }),
      titulo: issue.titulo,
      corpo: issue.corpo,
      emExecucao: issue.etiquetas.some((e) => ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA.includes(e)),
      agora: agora(),
    })
    await deps.gravarConferencia(issue.numero, gravada)

    const mudouParaErro = !gravada.padraoOk && antes?.['hashDosErros'] !== gravada.hashDosErros
    const voltouAoPadrao = gravada.padraoOk && antes?.['padraoOk'] === false
    if (mudouParaErro || voltouAoPadrao) {
      await deps.registrarNoPainel({
        chave: `conferencia:${deps.repo}:${issue.numero}:${gravada.hashDosErros}`,
        texto: textoDoEvento(deps.repo, issue.numero, gravada),
      })
    }
  }
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null
}

/** O conferidor ligado ao banco: o que o scheduler monta no gancho `conferirTarefa` da varredura. */
export function montarConferenciaDoRetrato(args: {
  prisma: Pick<PrismaClient, 'repoItem' | 'event'>
  projectId: string
  repo: string
  lerQuadro: () => Promise<QuadroParaConferir | null>
  agora?: () => Date
  onWarn?: (mensagem: string) => void
}): (issue: IssueParaConferir) => Promise<void> {
  return criarConferidorDeTarefa({
    repo: args.repo,
    lerQuadro: args.lerQuadro,
    ...(args.agora ? { agora: args.agora } : {}),
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
    lerConferenciasAnteriores: async () => {
      const linhas = await args.prisma.repoItem.findMany({
        where: { projectId: args.projectId, tipo: 'issue' },
        select: { numero: true, conferencia: true },
      })
      return new Map(linhas.map((l) => [l.numero, objeto(l.conferencia)]))
    },
    gravarConferencia: async (numero, conferencia) => {
      const gravou = await mesclarConferenciaDoItem({
        prisma: args.prisma,
        projectId: args.projectId,
        tipo: 'issue',
        numero,
        parcial: { ...conferencia },
      })
      if (!gravou) {
        args.onWarn?.(`conferência: a ficha da tarefa #${numero} de ${args.repo} não foi gravada`)
      }
    },
    registrarNoPainel: async (evento) => {
      await registrarNoPainelUmaVez({
        prisma: args.prisma,
        projectId: args.projectId,
        chave: evento.chave,
        texto: evento.texto,
      })
    },
  })
}

function paraConferir(leitura: LeituraDoQuadro): QuadroParaConferir {
  return {
    itens: new Map(leitura.itens.map((i) => [i.pedido, { iteracaoId: i.iteracaoId }])),
    iteracaoCorrenteId: leitura.iteracaoCorrenteId,
    truncado: leitura.truncado,
  }
}

/**
 * O leitor do quadro: acha o quadro do projeto, passa pelo cache de leitura
 * compartilhado e entrega no formato da conferência. Pula (devolve `null`)
 * quando o freio de cota do GitHub está ativo.
 */
export function criarLeitorDoQuadro(deps: {
  resolverQuadro: () => Promise<{ quadroId: string; token: string } | null>
  /** Só leitura: a guarda de autonomia não entra aqui porque nada é escrito. */
  fetchImpl: typeof fetch
  /** `true` pula a leitura (freio de cota); quem chama escreve a linha de log. */
  freioAtivo?: () => boolean
  agora?: () => Date
}): () => Promise<QuadroParaConferir | null> {
  return async () => {
    if (deps.freioAtivo?.()) return null
    const resolvido = await deps.resolverQuadro()
    if (!resolvido) return null
    const cliente = new ProjectV2Client({ token: resolvido.token, fetchImpl: deps.fetchImpl })
    const leitura = await lerQuadroComCache(
      resolvido.quadroId,
      () => lerQuadroCompleto(cliente, resolvido.quadroId),
      deps.agora
    )
    return paraConferir(leitura)
  }
}

/**
 * Guarda por um tempo qual é o quadro de cada projeto: achá-lo custa uma ou
 * duas consultas por ciclo, e o quadro de um projeto não muda a cada 30 min.
 * Resultado nulo (sem quadro) não fica guardado — a próxima passada tenta de novo.
 */
export function criarResolvedorComCache<T>(
  resolver: (projectId: string) => Promise<T | null>,
  opcoes: { validadeMs: number; agora?: () => Date }
): (projectId: string) => Promise<T | null> {
  const guardados = new Map<string, { valor: T; ate: number }>()
  const agora = opcoes.agora ?? (() => new Date())
  return async (projectId) => {
    const instante = agora().getTime()
    const guardado = guardados.get(projectId)
    if (guardado && guardado.ate > instante) return guardado.valor
    const valor = await resolver(projectId)
    if (valor !== null) guardados.set(projectId, { valor, ate: instante + opcoes.validadeMs })
    else guardados.delete(projectId)
    return valor
  }
}
