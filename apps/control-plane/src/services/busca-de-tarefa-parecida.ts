// A missão do RA procurando a tarefa de um pull request pelo código, e o PO
// perguntando ao dono quando o analista não acha.
//
// `acharTarefaDoItem` (vinculo-da-tarefa.ts) liga o pull request à tarefa
// quando existe pista (sessão do dev, "fecha #N", branch). Sobra o pull request
// sem pista nenhuma: de gente, ou de um assistente de código que não citou a
// tarefa. Aqui o analista lê os arquivos mexidos e diz se alguma tarefa ABERTA
// descreve a mudança (`racharTarefaParecidaPeloCodigo`); se não disser, ou se
// disser uma que não existe, o dono é perguntado (`perguntarSobreVinculoDaTarefa`).
//
// O motor de IA só existe dentro da missão, então isto roda como "extra" do RA.
// Quem decide é o sistema, não o analista: o número que ele devolve só vale se
// estiver na lista de tarefas abertas que o próprio sistema leu, e o vínculo
// que sai daí é um PALPITE (`vinculo_origem = 'codigo'`): nada que age no
// GitHub o usa até o dono confirmar (ver `issueConfiavelDaFicha`).
//
// Freios que mantêm a conta de chamadas e de motor baixa:
//  - no máximo 3 pull requests analisados por missão;
//  - uma tentativa por (pull request, cabeça do pull request): o rastro da
//    tentativa é o registro no painel, e um push novo vale outra tentativa;
//  - no máximo 2 perguntas novas por missão, e nenhuma enquanto a anterior
//    sobre o mesmo pull request está aberta ou já foi respondida;
//  - o freio de cota do GitHub pula a rodada inteira;
//  - o pull request que o analista já olhou e não achou NÃO volta para a fila
//    do analista: a pergunta que sobrou do teto sai na missão seguinte, sem
//    gastar motor.

import type { PrismaClient } from '@prisma/client'
import { RailsStepError } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import { atualizarFichaDoItem, lerFichaDoItem, type PrismaDaFichaDoItem } from './ficha-do-item.js'
import { registrarNoPainelUmaVez } from './registro-no-painel.js'
import { pularSeFreioDeCotaAtivo } from './freio-de-cota-do-github.js'
import { lerCuidaPorOrigem } from './cuidado-por-origem.js'
import { baldeDeCuidado } from './motor-do-proximo-passo.js'
import { racharTarefaParecidaPeloCodigo } from './tarefa-parecida-pelo-codigo.js'
import {
  dedupKeyDeVinculoDaTarefa,
  perguntarSobreVinculoDaTarefa,
  type AgentQuestionAskerDeVinculo,
  type IssueCandidata,
} from './perguntar-vinculo-da-tarefa.js'
import { contextoExecutivoVazio } from './contexto-executivo-da-pergunta.js'
import { cortarPorPontoDeCodigo, limparSurrogates } from './texto-seguro.js'

export const TETO_DE_PRS_POR_MISSAO = 3
export const TETO_DE_PERGUNTAS_POR_MISSAO = 2

/** Quantas páginas de 100 issues abertas a rodada lê (a lista é a régua do que vale como tarefa). */
const MAX_PAGINAS_DE_ISSUES = 3

/** Quanto do resumo dos arquivos (e do trecho de cada um) vai para o prompt. */
const MAX_ARQUIVOS_NO_RESUMO = 40
const MAX_PATCH_POR_ARQUIVO = 400
const MAX_RESUMO_DOS_ARQUIVOS = 6_000

/** Origens que não são trabalho de ninguém para ligar a uma tarefa. */
const ORIGENS_DE_BOT = new Set(['dependabot', 'outro_bot'])

export type PrismaDaBuscaDeTarefa = Pick<PrismaClient, 'repoItem' | 'event' | 'agentQuestion'>

export interface DepsDaBuscaDeTarefaParecida {
  prisma: PrismaDaBuscaDeTarefa
  projectId: string
  /** `dono/repo`. */
  repo: string
  /** O dono do projeto; nulo = não há a quem perguntar. */
  userId: string | null
  /** `Project.runtimeConfig`: de onde vem `cuidaPorOrigem`. */
  runtimeConfig: unknown
  /** O contexto que o RA já montou para a missão. */
  contextBlocks: string[]
  /** O motor de IA da missão (o mesmo que os outros passos do RA usam). */
  execute: StepExecutor
  /** Leitura do GitHub: lança o erro tipado e registra o freio de cota. */
  ghGet: (caminho: string) => Promise<unknown>
  /** O serviço de perguntas ao dono; `null` = indisponível, nada é perguntado. */
  agentQuestion: AgentQuestionAskerDeVinculo | null
  agora?: () => Date
  info?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

export interface ResultadoDaBuscaDeTarefa {
  /** Pull requests que o analista olhou nesta rodada. */
  analisados: number
  /** Vínculos gravados como palpite (`codigo`). */
  vinculados: Array<{ pr: number; issue: number }>
  /** Pull requests sobre os quais o dono foi perguntado agora. */
  perguntados: number[]
  /** A rodada inteira foi pulada porque o GitHub está em freio de cota. */
  puladoPorFreio: boolean
}

interface PrAberto {
  numero: number
  titulo: string
  headSha: string
}

interface IssueDoGitHub {
  number?: unknown
  title?: unknown
  pull_request?: unknown
}

interface ArquivoDoPr {
  filename?: unknown
  status?: unknown
  additions?: unknown
  deletions?: unknown
  patch?: unknown
}

function chaveDaTentativa(repo: string, pr: number, headSha: string): string {
  return `vinculo-ra:${repo}:${pr}:${headSha}`
}

function resumirArquivos(arquivos: ArquivoDoPr[]): string {
  const linhas: string[] = []
  for (const a of arquivos.slice(0, MAX_ARQUIVOS_NO_RESUMO)) {
    if (typeof a.filename !== 'string') continue
    const status = typeof a.status === 'string' ? a.status : 'modified'
    const mais = typeof a.additions === 'number' ? a.additions : 0
    const menos = typeof a.deletions === 'number' ? a.deletions : 0
    linhas.push(`${a.filename} (${status}, +${mais} -${menos})`)
    if (typeof a.patch === 'string' && a.patch.trim() !== '') {
      linhas.push(cortarPorPontoDeCodigo(a.patch, MAX_PATCH_POR_ARQUIVO))
    }
  }
  const resto = arquivos.length - MAX_ARQUIVOS_NO_RESUMO
  if (resto > 0) linhas.push(`… e mais ${resto} arquivo(s)`)
  const texto = linhas.join('\n')
  return texto.length > MAX_RESUMO_DOS_ARQUIVOS
    ? `${cortarPorPontoDeCodigo(texto, MAX_RESUMO_DOS_ARQUIVOS)}\n…`
    : limparSurrogates(texto)
}

/** As tarefas que o analista citou na justificativa vêm primeiro; o resto, as mais recentes. */
function candidatasDaPergunta(issues: IssueCandidata[], justificativa: string): IssueCandidata[] {
  const porNumero = new Map(issues.map((i) => [i.numero, i]))
  const citadas: IssueCandidata[] = []
  for (const achado of justificativa.matchAll(/#(\d+)/g)) {
    const issue = porNumero.get(Number(achado[1]))
    if (issue && !citadas.includes(issue)) citadas.push(issue)
  }
  const recentes = [...issues]
    .filter((i) => !citadas.includes(i))
    .sort((a, b) => b.numero - a.numero)
  return [...citadas, ...recentes]
}

export async function buscarTarefaParecidaDosPrs(
  deps: DepsDaBuscaDeTarefaParecida
): Promise<ResultadoDaBuscaDeTarefa> {
  const agora = deps.agora ?? (() => new Date())
  const resultado: ResultadoDaBuscaDeTarefa = {
    analisados: 0,
    vinculados: [],
    perguntados: [],
    puladoPorFreio: false,
  }

  // 1) Quem pode ser procurado: aberto, sem tarefa, de uma origem que não é bot
  //    e que a configuração do projeto não mandou ignorar.
  const cuida = lerCuidaPorOrigem(deps.runtimeConfig, false)
  const fichas = await deps.prisma.repoItem.findMany({
    where: {
      projectId: deps.projectId,
      tipo: 'pr',
      issueNumber: null,
      estado: { path: ['status'], equals: 'open' },
    },
    select: { numero: true, origem: true },
    orderBy: { numero: 'desc' },
  })
  const candidatos = fichas.filter((f) => {
    if (f.origem !== null && ORIGENS_DE_BOT.has(f.origem)) return false
    const balde = baldeDeCuidado(f.origem ?? 'desconhecido')
    return balde !== null && cuida[balde] !== 'nao'
  })
  if (candidatos.length === 0) return resultado

  if (
    pularSeFreioDeCotaAtivo({
      etapa: 'tarefa-parecida-pelo-codigo',
      repositorio: deps.repo,
      agora: agora(),
      jaAvisados: new Set(),
      info: (m) => deps.info?.(m),
    })
  ) {
    resultado.puladoPorFreio = true
    return resultado
  }

  let issuesAbertas: IssueCandidata[] | null = null
  const lerIssuesAbertas = async (): Promise<IssueCandidata[]> => {
    if (issuesAbertas !== null) return issuesAbertas
    const lidas: IssueCandidata[] = []
    for (let pagina = 1; pagina <= MAX_PAGINAS_DE_ISSUES; pagina += 1) {
      const lote = (await deps.ghGet(
        `/repos/${deps.repo}/issues?state=open&per_page=100&page=${pagina}`
      )) as IssueDoGitHub[]
      for (const i of lote) {
        // A rota de issues devolve os pull requests junto.
        if (i.pull_request) continue
        if (typeof i.number !== 'number' || typeof i.title !== 'string') continue
        lidas.push({ numero: i.number, titulo: i.title })
      }
      if (lote.length < 100) break
    }
    issuesAbertas = lidas
    return lidas
  }

  // Quanto o analista disse de cada pull request nesta rodada (alimenta as candidatas da pergunta).
  const justificativas = new Map<number, string>()
  /** Os que o analista já olhou NESTA cabeça e continuam sem tarefa: candidatos à pergunta. */
  const semTarefaAposAnalise: PrAberto[] = []

  try {
    // 2) A cabeça de cada pull request (para a chave da tentativa) e se ele ainda está aberto.
    const abertos = (await deps.ghGet(
      `/repos/${deps.repo}/pulls?state=open&per_page=100`
    )) as Array<{
      number?: unknown
      title?: unknown
      head?: { sha?: unknown }
    }>
    const porNumero = new Map<number, PrAberto>()
    for (const p of abertos) {
      if (typeof p.number !== 'number' || typeof p.head?.sha !== 'string') continue
      porNumero.set(p.number, {
        numero: p.number,
        titulo: typeof p.title === 'string' ? p.title : '',
        headSha: p.head.sha,
      })
    }
    if (abertos.length >= 100) {
      deps.onWarn?.(
        `tarefa-parecida: ${deps.repo} tem 100 ou mais pull requests abertos; só os da primeira página entram na busca`
      )
    }

    // 3) Quem já foi olhado nesta cabeça fica fora da fila do analista (e
    //    segue para a pergunta); quem não foi entra, até o teto.
    const naFila: PrAberto[] = []
    for (const c of candidatos) {
      const pr = porNumero.get(c.numero)
      if (!pr) continue
      const tentativa = await deps.prisma.event.findFirst({
        where: {
          projectId: deps.projectId,
          type: 'audit',
          payload: { path: ['chave'], equals: chaveDaTentativa(deps.repo, pr.numero, pr.headSha) },
        },
      })
      if (tentativa) semTarefaAposAnalise.push(pr)
      else naFila.push(pr)
    }

    // 4) O analista, um pull request por vez.
    for (const pr of naFila.slice(0, TETO_DE_PRS_POR_MISSAO)) {
      const issues = await lerIssuesAbertas()
      const arquivos = (await deps.ghGet(
        `/repos/${deps.repo}/pulls/${pr.numero}/files?per_page=100`
      )) as ArquivoDoPr[]

      let issueSugerida: number | null = null
      let justificativa = ''
      try {
        const achado = await racharTarefaParecidaPeloCodigo({
          numeroDoPr: pr.numero,
          repository: deps.repo,
          diffResumo: resumirArquivos(arquivos),
          contextBlocks: deps.contextBlocks,
          issuesAbertas: issues,
          execute: deps.execute,
        })
        issueSugerida = achado.issueNumberEncontrado
        justificativa = achado.justificativa
      } catch (erro) {
        // O motor respondeu, mas o formulário nunca validou: vale como "não achou".
        if (!(erro instanceof RailsStepError)) {
          // Processo do motor caído, cota, login: os próximos pull requests cairiam no mesmo
          // buraco, e a tentativa NÃO é registrada, para valer de novo na missão seguinte.
          deps.onWarn?.(
            `tarefa-parecida: o motor falhou no pull request #${pr.numero} de ${deps.repo}: ${erro}`
          )
          break
        }
      }
      resultado.analisados += 1
      justificativas.set(pr.numero, justificativa)

      // O LLM decide, o sistema executa: o número só vale se for de uma tarefa aberta.
      const tarefa =
        issueSugerida !== null && Number.isInteger(issueSugerida)
          ? issues.find((i) => i.numero === issueSugerida)
          : undefined

      const chave = chaveDaTentativa(deps.repo, pr.numero, pr.headSha)
      if (tarefa) {
        // Outra via (a varredura do retrato) pode ter ligado o pull request enquanto o motor pensava.
        const atual = await lerFichaDoItem({
          prisma: deps.prisma as unknown as PrismaDaFichaDoItem,
          projectId: deps.projectId,
          tipo: 'pr',
          numero: pr.numero,
        })
        if (atual && atual.issueNumber !== null) {
          await registrarNoPainelUmaVez({
            prisma: deps.prisma,
            projectId: deps.projectId,
            chave,
            texto:
              `GitOrch: o analista sugeriu a tarefa #${tarefa.numero} para o pull request #${pr.numero}, ` +
              `mas ele já foi ligado à tarefa #${atual.issueNumber}; a sugestão foi descartada.`,
          })
          continue
        }
        await atualizarFichaDoItem({
          prisma: deps.prisma as unknown as PrismaDaFichaDoItem,
          projectId: deps.projectId,
          tipo: 'pr',
          numero: pr.numero,
          issueNumber: tarefa.numero,
          vinculoOrigem: 'codigo',
        })
        resultado.vinculados.push({ pr: pr.numero, issue: tarefa.numero })
        await registrarNoPainelUmaVez({
          prisma: deps.prisma,
          projectId: deps.projectId,
          chave,
          texto:
            `GitOrch: o analista leu o código do pull request #${pr.numero} e sugere que ele ` +
            `pertence à tarefa #${tarefa.numero} ("${tarefa.titulo}"). É só uma sugestão: nada age ` +
            'em cima dela até você confirmar.',
        })
        continue
      }

      const descartada =
        issueSugerida !== null
          ? ` Ele sugeriu a tarefa #${issueSugerida}, que não está entre as tarefas abertas; a sugestão foi descartada.`
          : ''
      await registrarNoPainelUmaVez({
        prisma: deps.prisma,
        projectId: deps.projectId,
        chave,
        texto:
          `GitOrch: o analista procurou, pelo código, a tarefa do pull request #${pr.numero} e não ` +
          `achou nenhuma tarefa aberta que o descreva.${descartada}`,
      })
      semTarefaAposAnalise.push(pr)
    }

    // 5) A pergunta ao dono, para quem o analista olhou e não achou.
    if (deps.userId !== null && deps.agentQuestion !== null) {
      for (const pr of semTarefaAposAnalise) {
        if (resultado.perguntados.length >= TETO_DE_PERGUNTAS_POR_MISSAO) break
        const dedupKey = dedupKeyDeVinculoDaTarefa(deps.repo, pr.numero)
        // `ask` só deduplica contra pergunta RESPONDIDA; a aberta tem que ser conferida aqui,
        // senão a mesma pergunta nasce de novo a cada missão.
        const jaPerguntado = await deps.prisma.agentQuestion.findFirst({
          where: { projectId: deps.projectId, dedupKey, status: { in: ['open', 'answered'] } },
          select: { id: true },
        })
        if (jaPerguntado) continue
        const issues = await lerIssuesAbertas()
        try {
          await perguntarSobreVinculoDaTarefa(
            {
              userId: deps.userId,
              projectId: deps.projectId,
              numeroDoPr: pr.numero,
              repository: deps.repo,
              tituloDoPr: pr.titulo,
              contexto: contextoExecutivoVazio(),
              candidatas: candidatasDaPergunta(issues, justificativas.get(pr.numero) ?? ''),
            },
            { agentQuestion: deps.agentQuestion }
          )
          resultado.perguntados.push(pr.numero)
        } catch (erro) {
          // Uma pergunta que não saiu não conta no teto e volta na missão seguinte.
          deps.onWarn?.(
            `tarefa-parecida: não consegui perguntar ao dono sobre o pull request #${pr.numero} de ${deps.repo}: ${erro}`
          )
        }
      }
    }
  } catch (erro) {
    // Falha de leitura do GitHub (cota, permissão, rede): não insiste nesta rodada.
    deps.onWarn?.(`tarefa-parecida: rodada interrompida em ${deps.repo}: ${erro}`)
  }

  return resultado
}

/** A linha que a missão do RA acrescenta à saída; vazia quando nada aconteceu. */
export function resumoDaBusca(r: ResultadoDaBuscaDeTarefa): string {
  if (r.analisados === 0 && r.perguntados.length === 0) return ''
  const partes = [
    `${r.analisados} pull request(s) olhado(s) pelo código`,
    `${r.vinculados.length} tarefa(s) sugerida(s)`,
    `${r.perguntados.length} pergunta(s) ao dono`,
  ]
  return `Busca da tarefa pelo código: ${partes.join(', ')}.`
}
