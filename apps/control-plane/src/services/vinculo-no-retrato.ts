// Liga o pull request aberto à tarefa de origem dentro da varredura do retrato.
//
// `acharTarefaDoItem` (vinculo-da-tarefa.ts) sabe responder "de qual tarefa é
// este PR?", mas só um script avulso o chamava: no serviço, o PR de gente
// ficava sem tarefa para sempre, mesmo quando o dev assíncrono tinha a sessão
// registrada com o número do PR. Aqui a pergunta entra na varredura de 30 min,
// com os três freios que mantêm a conta de chamadas ao GitHub baixa:
//
//  - só PR aberto, ainda sem tarefa na ficha e que não é de bot;
//  - se a sessão do dev já guarda o número do PR, a linha guardada responde e
//    a consulta formal (GraphQL) nem sai;
//  - PR sem pista fica 6 h sem ser reconsultado (cache em memória), e o freio
//    de cota do GitHub pula a consulta formal.
//
// A camada formal ("este PR fecha a issue N" segundo o GitHub) aceita PR de
// qualquer autor, inclusive de gente: aqui ela só VINCULA. Quem decide se a
// entrega é do dev assíncrono (e se pode ser mesclada sozinha) continua sendo
// a prova de delegação, nunca o vínculo.

import type { PrismaClient } from '@prisma/client'
import { ProjectV2Client } from '@gitorch/github-sync'
import {
  acharTarefaDoItem,
  type OrigemDoVinculo,
  type SessaoParaVinculo,
} from './vinculo-da-tarefa.js'
import { atualizarFichaDoItem, type PrismaDaFichaDoItem } from './ficha-do-item.js'
import { pularSeFreioDeCotaAtivo } from './freio-de-cota-do-github.js'
import { registrarNoPainelUmaVez } from './registro-no-painel.js'

/** A etiqueta que marca a tarefa entregue ao dev assíncrono. */
export const ETIQUETA_DE_DELEGACAO = 'jules'

/** Quanto tempo um PR sem pista fica sem ser reconsultado. */
export const JANELA_DO_CACHE_NEGATIVO_MS = 6 * 60 * 60_000

/** Quantos PRs por projeto a varredura tenta ligar a cada ciclo. */
export const TETO_DE_VINCULOS_POR_CICLO = 5

/** Quanto tempo, por projeto e ciclo, a varredura gasta tentando ligar PRs. */
export const ORCAMENTO_DO_VINCULO_MS = 8_000

/** Origens que não são trabalho encomendado nem de gente: nunca têm tarefa para achar. */
const ORIGENS_DE_BOT = new Set(['dependabot', 'outro_bot'])

/** Origens de baixa confiança que a sessão do dev assíncrono desmente. */
const ORIGENS_CORRIGIVEIS_PELA_SESSAO = new Set<string | null>([null, 'pessoa', 'jules_fora'])

/** O mínimo do PR cru que a busca lê (o `/pulls?state=open` já traz tudo isto). */
export interface PrParaVincular {
  number: number
  body?: string | undefined
  user?: { login?: string | undefined } | undefined
  head?: { ref?: string | undefined } | undefined
}

export interface FichaParaVincular {
  origem: string | null
  issueNumber: number | null
}

export interface DepsDoVinculador {
  projectId: string
  /** `dono/repo`. */
  repo: string
  lerFicha: (numero: number) => Promise<FichaParaVincular | null>
  /** Sessões do dev assíncrono deste projeto (vivas e fechadas). Lida no máximo uma vez. */
  lerSessoes: () => Promise<SessaoParaVinculo[]>
  /** A consulta formal do GitHub (`closingIssuesReferences`). */
  closingIssues: (numero: number) => Promise<number[]>
  gravar: (args: {
    numero: number
    issueNumber: number
    vinculoOrigem: OrigemDoVinculo
    /** Só presente quando a sessão do dev desmente a origem gravada. */
    origem?: string
  }) => Promise<void>
  registrarNoPainel: (args: { chave: string; texto: string }) => Promise<void>
  /** `projectId:pr` → quando a última consulta completa não achou nada. Vive no processo. */
  cacheNegativo: Map<string, number>
  agora: () => Date
  info?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

export interface ArgsDoVinculo {
  numero: number
  pr: PrParaVincular
  /** As etiquetas da issue, lidas da lista de issues abertas que a varredura já baixou. */
  etiquetasDaIssue: (issueNumber: number) => readonly string[]
}

const COMO_FOI_ACHADO: Record<OrigemDoVinculo, string> = {
  formal: 'o próprio GitHub reconhece que o pull request fecha a tarefa',
  texto: 'a entrega está registrada para a tarefa do dev assíncrono',
  'branch-do-jules': 'o nome do branch identifica a sessão do dev assíncrono',
}

/**
 * Devolve a função que a varredura chama por PR. Responde `true` quando
 * procurou de verdade (gasta o teto do ciclo) e `false` quando não havia nada
 * a procurar (ficha ausente, tarefa já ligada, bot, ou PR em quarentena).
 */
export function criarVinculadorDeTarefa(
  deps: DepsDoVinculador
): (args: ArgsDoVinculo) => Promise<boolean> {
  let sessoes: Promise<SessaoParaVinculo[]> | null = null
  const lerSessoesUmaVez = (): Promise<SessaoParaVinculo[]> => {
    if (sessoes === null) {
      sessoes = deps.lerSessoes().catch((erro: unknown) => {
        sessoes = null
        throw erro
      })
    }
    return sessoes
  }
  const jaAvisadosDoFreio = new Set<string>()

  return async ({ numero, pr, etiquetasDaIssue }) => {
    const ficha = await deps.lerFicha(numero)
    if (!ficha || ficha.issueNumber !== null) return false
    if (ficha.origem !== null && ORIGENS_DE_BOT.has(ficha.origem)) return false

    const todasAsSessoes = await lerSessoesUmaVez()
    // A linha guardada na delegação é autoritativa (pr-delegado.ts): quando ela
    // existe, a consulta formal não acrescenta nada e não é feita.
    const linhaGuardada = todasAsSessoes.some((s) => s.pullRequestNumber === numero)

    // O cache negativo só vale para a consulta de rede. A linha de sessão é
    // leitura local e vem ANTES dele: uma sessão criada depois do "sem vínculo"
    // não pode ficar escondida pela janela inteira.
    const chaveDoCache = `${deps.projectId}:${numero}`
    const consultadoEm = deps.cacheNegativo.get(chaveDoCache)
    if (
      !linhaGuardada &&
      consultadoEm !== undefined &&
      deps.agora().getTime() - consultadoEm < JANELA_DO_CACHE_NEGATIVO_MS
    ) {
      return false
    }

    const emFreio =
      !linhaGuardada &&
      pularSeFreioDeCotaAtivo({
        etapa: 'vinculo-da-tarefa',
        repositorio: deps.repo,
        agora: deps.agora(),
        jaAvisados: jaAvisadosDoFreio,
        info: (m) => deps.info?.(m),
      })

    const vinculo = await acharTarefaDoItem({
      numeroDoPr: numero,
      autor: pr.user?.login,
      corpo: pr.body,
      headRefName: pr.head?.ref,
      sessoes: todasAsSessoes,
      closingIssues: () =>
        linhaGuardada || emFreio ? Promise.resolve([]) : deps.closingIssues(numero),
      issueComEtiquetaDeDelegacao: (issue) =>
        etiquetasDaIssue(issue).includes(ETIQUETA_DE_DELEGACAO),
    })

    if (!vinculo) {
      // Em freio a consulta formal não rodou: "sem vínculo" seria palpite.
      if (!emFreio) deps.cacheNegativo.set(chaveDoCache, deps.agora().getTime())
      return true
    }

    deps.cacheNegativo.delete(chaveDoCache)
    // Só o que vem de SESSÃO do dev assíncrono desmente a origem: a linha que
    // guarda o número do PR, ou o identificador da sessão no nome do branch.
    // O vínculo formal e o texto do corpo não provam quem encomendou o PR.
    const vemDeSessao = linhaGuardada || vinculo.origemDoVinculo === 'branch-do-jules'
    const corrigeOrigem = vemDeSessao && ORIGENS_CORRIGIVEIS_PELA_SESSAO.has(ficha.origem)

    await deps.gravar({
      numero,
      issueNumber: vinculo.issueNumber,
      vinculoOrigem: vinculo.origemDoVinculo,
      ...(corrigeOrigem ? { origem: 'jules_gitorch' } : {}),
    })

    try {
      await deps.registrarNoPainel({
        chave: `vinculo-da-tarefa:${deps.repo}:${numero}:${vinculo.issueNumber}`,
        texto: `Pull request #${numero} ligado à tarefa #${vinculo.issueNumber}: ${COMO_FOI_ACHADO[vinculo.origemDoVinculo]}.`,
      })
    } catch (erro) {
      // O vínculo já está gravado; o aviso na timeline é só o rastro.
      deps.onWarn?.(
        `vinculo-da-tarefa: pull request #${numero} de ${deps.repo} ligado, mas o registro no painel falhou: ${erro}`
      )
    }
    return true
  }
}

export interface ArgsDoVinculoNoRetrato {
  prisma: Pick<PrismaClient, 'repoItem' | 'devSession' | 'event'>
  projectId: string
  repo: string
  githubToken: string
  /** O mesmo mapa entre os ciclos do processo (o cache negativo precisa sobreviver a eles). */
  cacheNegativo: Map<string, number>
  /** Transporte do GraphQL (o serviço injeta um com teto de tempo; o teste, um local). */
  fetchImpl?: typeof fetch
  agora?: () => Date
  info?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

/** O bloco `vincularTarefa` de `VarreduraDoRetratoDeps`, ligado ao banco e ao GitHub reais. */
export function montarVinculoDoRetrato(args: ArgsDoVinculoNoRetrato) {
  const [dono, nome] = args.repo.split('/')
  const cliente = new ProjectV2Client({
    token: args.githubToken,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  })
  // `atualizarFichaDoItem` pede um recorte do Prisma que o cliente gerado não
  // satisfaz estruturalmente (o `upsert` dele tem tipos de entrada próprios).
  const prismaDaFicha = args.prisma as unknown as PrismaDaFichaDoItem

  const aplicar = criarVinculadorDeTarefa({
    projectId: args.projectId,
    repo: args.repo,
    cacheNegativo: args.cacheNegativo,
    agora: args.agora ?? (() => new Date()),
    ...(args.info ? { info: args.info } : {}),
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
    lerFicha: (numero) =>
      args.prisma.repoItem.findFirst({
        where: { projectId: args.projectId, tipo: 'pr', numero },
        select: { origem: true, issueNumber: true },
      }),
    lerSessoes: () =>
      args.prisma.devSession.findMany({
        where: { projectId: args.projectId },
        select: { sessionName: true, issueNumber: true, pullRequestNumber: true },
      }),
    closingIssues: async (numero) => {
      if (!dono || !nome) throw new Error(`repositório inválido: ${args.repo}`)
      return cliente.closingIssuesDoPr({ owner: dono, repo: nome, prNumber: numero })
    },
    gravar: async (item) => {
      await atualizarFichaDoItem({
        prisma: prismaDaFicha,
        projectId: args.projectId,
        tipo: 'pr',
        numero: item.numero,
        issueNumber: item.issueNumber,
        vinculoOrigem: item.vinculoOrigem,
        ...(item.origem ? { origem: item.origem } : {}),
      })
    },
    registrarNoPainel: ({ chave, texto }) =>
      registrarNoPainelUmaVez({
        prisma: args.prisma,
        projectId: args.projectId,
        chave,
        texto,
      }),
  })

  return { aplicar, teto: TETO_DE_VINCULOS_POR_CICLO, orcamentoMs: ORCAMENTO_DO_VINCULO_MS }
}
