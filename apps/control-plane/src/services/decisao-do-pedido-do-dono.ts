// A decisão do vigia para o PR aberto pela conta do DONO do projeto (a regra
// pura vive em `assumir-pedido-do-dono.ts`). Aqui entram as leituras do
// GitHub e a tradução da decisão para as ações que o vigia já sabe executar:
// em `cuidar`, passada a espera, devolve a MESMA ação `retomar` dos PRs do dev
// (a sessão parte da branch principal e cita o ramo do dono); em `sugerir`,
// usa a pergunta "cuido deste pedido?" que já existe; o resto é `ignorar`.
//
// Leituras baratas primeiro: rótulo, autonomia, rascunho e o estado do PR (que
// o vigia já trouxe na listagem) cortam antes de qualquer chamada. Só o PR com
// motivo para estar parado paga os comentários.

import type { PrismaClient } from '@prisma/client'
import {
  ABERTURA_DO_AVISO_AO_PARTICIPANTE,
  deveAssumirPedidoDoDono,
  lerEsperaDoDonoMs,
  temMarcaNaoMexer,
  ultimoMovimentoReal,
  type InteracaoNoPr,
} from './assumir-pedido-do-dono.js'
import { acharParecerNesteHead, ehAprovacao, type ReviewDoGithub } from './parecer-do-qa.js'
import { contextoExecutivoVazio } from './contexto-executivo-da-pergunta.js'
import {
  dedupKeyDeCuidaDestePedido,
  perguntarSeCuida,
  type AgentQuestionAskerDeCuidado,
} from './perguntar-se-cuida.js'
import type { StepExecutor } from './role-rails.js'
import {
  MAX_ACOES_DO_VIGIA,
  branchParaRetomar,
  descreverTempoParado,
  montarPedidoDeConsertoDoVigia,
  type AcaoDoVigia,
  type CausaDaParada,
  type PrAberto,
} from './vigia-do-pr.js'

export interface DepsDoPedidoDoDono {
  agora: Date
  projeto: { id: string; wingId: string; autonomia: string }
  token: string
  pr: PrAberto
  /** A tarefa de origem do PR, quando o produto a conhece. */
  issueNumber: number | null
  /** Quantas vezes o vigia já agiu neste PR (o freio por PR da retomada). */
  acoesAnteriores: number
  podeAbrirSessao: boolean
  /** Espera em milissegundos; sem ela vale a configurada. */
  esperaMs?: number
  ghGet: (caminho: string, token: string) => Promise<unknown>
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  prisma: Pick<PrismaClient, 'agentQuestion' | 'repoItem'>
  /** Quem pergunta ao dono em `sugerir`; sem isto a pergunta é pulada. */
  pergunta?: {
    userId: string
    agentQuestion: AgentQuestionAskerDeCuidado
    execute?: StepExecutor
  }
  onWarn: (mensagem: string) => void
}

interface ReviewLida extends ReviewDoGithub {
  user?: { login?: string; type?: string } | null
}

interface ComentarioLido {
  created_at?: string
  updated_at?: string
  body?: string
  user?: { login?: string; type?: string } | null
}

/** O parecer sem as marcas internas e sem o aviso que fala com o autor do PR. */
function parecerParaODev(parecer: string): string {
  const semAviso = parecer.split(ABERTURA_DO_AVISO_AO_PARTICIPANTE)[0] ?? ''
  return semAviso
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('<!--'))
    .join('\n')
    .trim()
}

/** O pedido que o dev automático recebe: o que consertar e onde está o trabalho do dono. */
export function montarPedidoDoDono(args: {
  numeroDoPr: number
  ramoDoPr: string
  parecer: string | null
  verificacaoVermelha: boolean
  conflito: boolean
}): string {
  const partes: string[] = [
    `O pull request #${args.numeroDoPr} foi aberto pela conta do dono do projeto e ficou parado ` +
      'sem ninguém mexer. Faça o ajuste que falta:',
  ]
  const parecer = args.parecer === null ? '' : parecerParaODev(args.parecer)
  if (parecer !== '') partes.push(`Parecer do revisor:\n${parecer}`)
  if (args.verificacaoVermelha) {
    partes.push(
      'A verificação automática está vermelha: conserte a causa (nunca desligue nem mascare o ' +
        'teste que reprovou).'
    )
  }
  if (args.conflito) {
    partes.push('Há conflito com a branch principal: resolva-o ao refazer o trabalho.')
  }
  return montarPedidoDeConsertoDoVigia({
    numeroDoPr: args.numeroDoPr,
    ramoDoPr: args.ramoDoPr,
    pedido: partes.join('\n\n'),
  })
}

function quandoEmPortugues(data: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(data)
}

const ignorar = (motivo: string): AcaoDoVigia => ({ acao: 'ignorar', motivo })

export async function decidirPedidoDoDono(deps: DepsDoPedidoDoDono): Promise<AcaoDoVigia> {
  const { pr, projeto } = deps
  const numero = pr.numero
  const esperaMs = deps.esperaMs ?? lerEsperaDoDonoMs()

  // Cortes que não custam chamada nenhuma.
  if (temMarcaNaoMexer(pr.labels)) {
    return ignorar(`#${numero} está marcado para o produto não mexer`)
  }
  if (projeto.autonomia !== 'cuidar' && projeto.autonomia !== 'sugerir') {
    return ignorar(`#${numero} é do dono e a autonomia do projeto não permite agir`)
  }
  if (pr.rascunho) return ignorar(`#${numero} é rascunho do dono, ainda em construção`)
  // Verificação pendente não corta aqui: num PR parado há mais de um dia ela é
  // verificação que nunca respondeu, e o conflito ou o parecer continuam valendo.
  if (pr.mergeable === null) {
    return ignorar(`#${numero}: o GitHub ainda está calculando se dá para mesclar`)
  }

  try {
    // O parecer do produto NESTE commit. Sem o commit, parecer nenhum vale.
    let parecer: string | null = null
    let interacoes: InteracaoNoPr[] = []
    if (pr.headSha) {
      const lidas = (await deps.ghGet(
        `/repos/${projeto.wingId}/pulls/${numero}/reviews?per_page=100`,
        deps.token
      )) as ReviewLida[] | null
      const reviewsLidas = Array.isArray(lidas) ? lidas : []
      const doProduto = acharParecerNesteHead(reviewsLidas, pr.headSha)
      if (doProduto?.body && !ehAprovacao(doProduto)) parecer = doProduto.body
      interacoes = reviewsLidas.map((r) => ({
        quando: r.submitted_at,
        login: r.user?.login,
        tipo: r.user?.type,
        corpo: r.body,
      }))
    }

    const causa: CausaDaParada | null =
      pr.mergeable === false
        ? 'conflito'
        : pr.verificacao === 'vermelha'
          ? 'ci-vermelha'
          : parecer !== null
            ? 'qa-reprovou'
            : null
    if (causa === null) return ignorar(`#${numero} do dono não tem nada a consertar`)

    // Só quem tem motivo paga os comentários. `since` traz apenas o que mexeu
    // dentro da espera: o que for mais velho que ela não muda a conta.
    const desde = new Date(deps.agora.getTime() - esperaMs).toISOString()
    for (const caminho of [
      `/repos/${projeto.wingId}/issues/${numero}/comments?since=${desde}&per_page=100`,
      `/repos/${projeto.wingId}/pulls/${numero}/comments?since=${desde}&per_page=100`,
    ]) {
      const lidos = (await deps.ghGet(caminho, deps.token)) as ComentarioLido[] | null
      for (const c of Array.isArray(lidos) ? lidos : []) {
        interacoes.push({
          quando: c.created_at,
          login: c.user?.login,
          tipo: c.user?.type,
          corpo: c.body,
        })
      }
    }

    const ultimoCommitEm = new Date(deps.agora.getTime() - pr.paradoHaMs)
    const decisao = deveAssumirPedidoDoDono({
      autonomia: projeto.autonomia,
      autorEhDono: true,
      marcaNaoMexer: false,
      ultimoMovimentoReal: ultimoMovimentoReal({ ultimoCommitEm, interacoes }),
      agora: deps.agora,
      motivoParado: causa,
      retomadasFeitas: deps.acoesAnteriores,
      teto: MAX_ACOES_DO_VIGIA,
      esperaMs,
    })

    if (decisao.decisao === 'espera') {
      await deps.registrarNoPainel(
        projeto.id,
        `pedido-do-dono:${projeto.wingId}:${numero}:${pr.headSha ?? 'sem-commit'}:espera`,
        `Pull request #${numero}: aguardando quem abriu; assumo a partir de ` +
          `${quandoEmPortugues(decisao.assumeEm)} se ninguém mexer até lá.`
      )
      return ignorar(`#${numero} do dono: aguardando quem abriu`)
    }

    if (decisao.decisao === 'pergunta') return await perguntar(deps, causa)

    if (decisao.decisao === 'nao-e-o-caso') {
      return ignorar(`#${numero} do dono: o produto não assume (${decisao.razao})`)
    }

    // Assume. Sem tarefa de origem não há como abrir a sessão do dev, e sem
    // ramo no repositório do projeto não há de onde partir.
    if (deps.issueNumber === null) {
      await deps.registrarNoPainel(
        projeto.id,
        `pedido-do-dono:${projeto.wingId}:${numero}:sem-tarefa`,
        `Pull request #${numero}: aberto pela conta do dono e parado, mas não está ligado a ` +
          'nenhuma tarefa do projeto; não consigo passar o ajuste ao dev automático.'
      )
      return ignorar(
        `#${numero} do dono: sem tarefa de origem, o dev automático não tem como abrir sessão`
      )
    }
    const ramo = branchParaRetomar(pr)
    if (ramo === null) {
      return ignorar(`#${numero} do dono: o ramo não está no repositório do projeto`)
    }
    if (!deps.podeAbrirSessao) {
      return ignorar(`#${numero}: sem vaga na conta do dev agora; fica para a próxima passada`)
    }

    return {
      acao: 'retomar',
      issueNumber: deps.issueNumber,
      causa: decisao.causa,
      branchDoPr: ramo,
      pedido: montarPedidoDoDono({
        numeroDoPr: numero,
        ramoDoPr: ramo,
        parecer,
        verificacaoVermelha: pr.verificacao === 'vermelha',
        conflito: pr.mergeable === false,
      }),
      motivo:
        `#${numero}, aberto pela conta do dono, está parado há mais de ` +
        `${descreverTempoParado(esperaMs)} sem ninguém mexer — passando o ajuste ao dev automático`,
      assumidoDoDono: true,
    }
  } catch (err) {
    deps.onWarn(
      `decidirPedidoDoDono: não deu para decidir o PR #${numero}: ${(err as Error).message}`
    )
    return ignorar(`#${numero} do dono: não consegui ler o GitHub; tento na próxima passada`)
  }
}

/** Projeto `sugerir`: a pergunta "cuido deste pedido?" que o produto já faz, uma só por PR. */
async function perguntar(deps: DepsDoPedidoDoDono, causa: CausaDaParada): Promise<AcaoDoVigia> {
  const { pr, projeto } = deps
  if (!deps.pergunta) {
    deps.onWarn(
      `decidirPedidoDoDono: sem serviço de perguntas para perguntar sobre o PR #${pr.numero}`
    )
    return ignorar(`#${pr.numero} do dono: não há como perguntar ao dono agora`)
  }
  // `ask` só deduplica contra pergunta JÁ RESPONDIDA: a aberta se confere aqui.
  const aberta = await deps.prisma.agentQuestion.findFirst({
    where: {
      projectId: projeto.id,
      dedupKey: dedupKeyDeCuidaDestePedido(projeto.wingId, pr.numero),
      status: 'open',
    },
  })
  if (aberta) return ignorar(`#${pr.numero} do dono: já há uma pergunta aberta ao dono`)

  await perguntarSeCuida(
    {
      userId: deps.pergunta.userId,
      projectId: projeto.id,
      numeroDoPr: pr.numero,
      repository: projeto.wingId,
      origem: 'pessoa',
      contexto: contextoExecutivoVazio(),
      contextoPr: {
        titulo: `PR #${pr.numero}`,
        idadeDias: Math.floor(pr.paradoHaMs / (24 * 60 * 60 * 1000)),
        idadeTexto: descreverTempoParado(pr.paradoHaMs),
        estadoCi: pr.verificacao,
        conflitos: causa === 'conflito',
      },
    },
    {
      agentQuestion: deps.pergunta.agentQuestion,
      ...(deps.pergunta.execute ? { execute: deps.pergunta.execute } : {}),
      onWarn: deps.onWarn,
      prisma: deps.prisma,
    }
  )
  return ignorar(`#${pr.numero} do dono: pergunta "cuido deste pedido?" enviada ao dono`)
}
