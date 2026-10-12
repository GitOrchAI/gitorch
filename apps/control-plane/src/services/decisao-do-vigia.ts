import { lerCuidaPorOrigem, lerJanelaEmConstrucaoHoras } from './cuidado-por-origem.js'
import { horasEmConstrucao } from './em-construcao.js'
import { decidirProximoPasso } from './motor-do-proximo-passo.js'
import { decidirDependabotExpresso } from './dependabot-expresso.js'
import { mesclarPr, type ResultadoDoMerge } from './merge-do-pr.js'
import { lerEstadoDoCiDoHead } from './estado-da-verificacao-do-github.js'
import { baseDoPrDe, branchPadraoDoRepositorio } from './base-do-dev.js'
import { chaveDoRegistroDoMotor } from './registro-do-motor.js'
import { lerFichaDoItem } from './ficha-do-item.js'
import {
  acharParecerNesteHead,
  ehAprovacao,
  ehReprovacaoCondicional,
  type ReviewDoGithub,
} from './parecer-do-qa.js'
import { montarDossieDoConflito } from './dossie-do-conflito.js'
import type { PrismaClient } from '@prisma/client'
import { contarAcoesDoVigia, descreverTempoParado, type VigiaDoPrDeps } from './vigia-do-pr.js'
import { perguntarSeCuida, type AgentQuestionAskerDeCuidado } from './perguntar-se-cuida.js'
import type {
  montarContextoExecutivoDaPergunta,
  DepsDoContextoExecutivo,
} from './contexto-executivo-da-pergunta.js'
import {
  ehEntregaDoDevAssincrono,
  ehOrigemDoDevAssincronoOuLegada,
  type OrigemDoItem,
} from './origem-do-item.js'
import { montarContextoDoItem } from './tudo-sobre-o-item.js'
import { comProjetoDaGuarda } from './guarda-de-autonomia.js'

type AcaoDoVigia = ReturnType<
  NonNullable<
    Parameters<typeof import('./vigia-do-pr.js').vigiarPrsOrfaos>[0]['decidirAcaoNoPrOrfao']
  >
>

export interface DecisaoDoVigiaDeps {
  runtimeConfig: unknown
  agora: Date
  projeto: { id: string; wingId: string }
  token: string
  depsVigia: Parameters<NonNullable<VigiaDoPrDeps['decidirAcaoNoPrOrfao']>>[0]
  prisma: PrismaClient
  ghGet: (caminho: string, token: string) => Promise<unknown>
  userId?: string | null | undefined
  agentQuestion?: AgentQuestionAskerDeCuidado | undefined
  montarContextoExecutivo?: typeof montarContextoExecutivoDaPergunta | undefined
  depsDoContexto?: DepsDoContextoExecutivo | undefined
  cortex?: import('@gitorch/cortex').CortexClient | undefined
  execute?: import('./role-rails.js').StepExecutor | undefined
  /** Fase 5.3/#802: escrita de merge do caminho expresso do Dependabot. */
  ghSend: (
    method: 'POST' | 'PATCH' | 'PUT',
    caminho: string,
    token: string,
    body: unknown
  ) => Promise<unknown>
  /** Fase 5.3/#802: registra na timeline do painel que o merge expresso aconteceu. */
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  /**
   * Fase 5.5: `true` quando o repositório não tem a proteção de senhas do GitHub
   * nem a alternativa gratuita rodando e o merge automático precisa de revisão.
   * Resolvido uma vez por projeto por dia (`criarGuardaDeSegurancaDoVigia`).
   */
  guardaDeSeguranca: () => Promise<boolean>
  /** Log de aviso não-fatal (falha ao buscar visibilidade do repo, falha na trava de parecer etc). */
  onWarn: (mensagem: string) => void
}

/**
 * O merge e as demais escritas desta decisão saem pela guarda de autonomia por
 * endereço; o projeto em andamento é informado a ela para que dois projetos do
 * mesmo repositório não herdem a autonomia um do outro.
 */
export function decidirAcaoNoPrOrfaoIntegrado(
  deps: DecisaoDoVigiaDeps
): Promise<Awaited<AcaoDoVigia>> {
  return comProjetoDaGuarda(deps.projeto.id, () => decidirNoProjeto(deps))
}

async function decidirNoProjeto({
  runtimeConfig,
  agora,
  projeto,
  token,
  depsVigia,
  prisma,
  ghGet,
  ghSend,
  registrarNoPainel,
  guardaDeSeguranca,
  onWarn,
  userId,
  agentQuestion,
  montarContextoExecutivo,
  depsDoContexto,
  execute,
}: DecisaoDoVigiaDeps): Promise<Awaited<AcaoDoVigia>> {
  const cuidaPorOrigem = lerCuidaPorOrigem(runtimeConfig, false)
  const janelaEmConstrucaoHoras = lerJanelaEmConstrucaoHoras(runtimeConfig)

  let origem = 'desconhecido'
  let emConstrucaoHa: number | null = null
  let entendimentoCompleto = false
  let vereditoDoQa: 'approve' | 'request_changes' | undefined
  let currentHeadSha: string | undefined
  let diffTruncado = false

  // Base, ramo e corpo do PR (agora) e branch padrão do repositório — o motor só
  // mescla sozinho PR que mira a branch padrão (merge-do-pr.ts) e nunca o do
  // aplicador de segurança, que o ramo e o corpo identificam. Lido fresco na
  // porta do merge.
  const lerBaseParaMerge = async (): Promise<{
    baseDoPr: string | null
    ramoDoPr: string | null
    corpoDoPr: string | null
    branchPadrao: string
  }> => {
    let baseDoPr: string | null = null
    let ramoDoPr: string | null = null
    let corpoDoPr: string | null = null
    try {
      const pr = (await ghGet(`/repos/${projeto.wingId}/pulls/${depsVigia.numero}`, token)) as {
        head?: { ref?: unknown }
        body?: unknown
      } | null
      baseDoPr = baseDoPrDe(pr)
      const ref = pr?.head?.ref
      ramoDoPr = typeof ref === 'string' && ref !== '' ? ref : null
      corpoDoPr = typeof pr?.body === 'string' ? pr.body : null
    } catch (err) {
      onWarn(
        `decidirAcaoNoPrOrfaoIntegrado: não deu para ler a base do PR #${depsVigia.numero}: ${(err as Error).message}`
      )
    }
    const branchPadrao = await branchPadraoDoRepositorio(
      async () => ghGet(`/repos/${projeto.wingId}`, token),
      onWarn
    )
    return { baseDoPr, ramoDoPr, corpoDoPr, branchPadrao }
  }

  // A cabeça VIVA do PR na porta do merge. `currentHeadSha` é o commit que o QA
  // aprovou (veio da varredura ou da leitura do começo da decisão); o que entra
  // na principal é o que está no PR agora. Comparar o aprovado com ele mesmo não
  // protege de nada: o porteiro de `mesclarPr` só serve se `shaAtual` for lido
  // aqui, fresco. Sem a leitura não há como saber o que entraria: `null`.
  const lerCabecaVivaParaMerge = async (): Promise<string | null> => {
    try {
      const pr = (await ghGet(`/repos/${projeto.wingId}/pulls/${depsVigia.numero}`, token)) as {
        head?: { sha?: unknown }
      } | null
      const sha = pr?.head?.sha
      if (typeof sha === 'string' && sha !== '') return sha
      onWarn(
        `decidirAcaoNoPrOrfaoIntegrado: a leitura do PR #${depsVigia.numero} não trouxe o commit atual`
      )
    } catch (err) {
      onWarn(
        `decidirAcaoNoPrOrfaoIntegrado: não deu para ler o commit atual do PR #${depsVigia.numero}: ${(err as Error).message}`
      )
    }
    return null
  }

  // O estado do CI relido fresco na porta do merge — a mesma leitura única do
  // QA. A varredura (`depsVigia.verificacao`) pode ter minutos de idade.
  const lerCiAgoraParaMerge = async (sha: string): Promise<string> =>
    (
      await lerEstadoDoCiDoHead({
        repositorio: projeto.wingId,
        sha,
        ghGet: (caminho) => ghGet(caminho, token),
      })
    ).estado

  // A origem, o entendimento e o último commit moram na ficha do PULL REQUEST
  // (é nele que a classificação do webhook e o formulário de entendimento
  // gravam), não na da tarefa de origem. A ficha pode ainda não existir: aí
  // a origem fica "desconhecido" e não há entendimento, e o motor não mescla.
  const ficha = await lerFichaDoItem({
    prisma: prisma as never,
    projectId: projeto.id,
    tipo: 'pr',
    numero: depsVigia.numero,
  })
  if (ficha) {
    origem = ficha.origem || 'desconhecido'
    emConstrucaoHa = horasEmConstrucao({
      rascunho: depsVigia.rascunho,
      ultimoCommitEm: ficha.estado.ultimoCommitEm ?? null,
      agora,
    })

    // O entendimento só vale enquanto a tarefa de origem segue aberta.
    const isIssueOpen = await depsVigia.issueAberta
    if (
      isIssueOpen &&
      !(ficha.estado as unknown as Record<string, unknown>)['fechadoEAbandonado'] &&
      ficha.entendimento
    ) {
      entendimentoCompleto = true
    }
  }

  // Fase 5.3/#802: caminho PRÓPRIO do Dependabot — não passa por
  // decidirProximoPasso (Tarefa 3.5), que trata TODO PR do Dependabot como
  // "automação sem conserto" (não há sessão para retomar). Aqui não há
  // conserto: só a decisão de mesclar, perguntar ou deixar quieto, que vive em
  // `dependabot-expresso.ts` (a mesma que o laço do vigia usa para o PR cujo
  // autor é o próprio Dependabot).
  if (origem === 'dependabot') {
    const expresso = await decidirDependabotExpresso({
      runtimeConfig,
      agora,
      projeto,
      token,
      numero: depsVigia.numero,
      verificacao: depsVigia.verificacao,
      mergeable: depsVigia.mergeable,
      ghGet,
      ghSend,
      registrarNoPainel,
      prisma,
      onWarn,
      pergunta:
        userId && agentQuestion
          ? { userId, agentQuestion, ...(execute ? { execute } : {}) }
          : undefined,
    })
    return { acao: expresso.acao, motivo: expresso.motivo }
  }

  // A guarda de segurança sai da sondagem do repositório, lida UMA vez por
  // projeto por dia e reaproveitada por todos os PRs (ver `exigir-revisao-de-seguranca.ts`).
  const exigeRevisaoDeSeguranca = await guardaDeSeguranca()

  let ultimoParecerQa: { body: string; timestamp: Date } | null = null
  let temDuvidaPendente = false
  let ultimoEscalonamentoEm: Date | null = null

  currentHeadSha = depsVigia.headSha ?? undefined

  if (origem !== 'dependabot') {
    try {
      if (!currentHeadSha && ehOrigemDoDevAssincronoOuLegada(origem)) {
        const prDetails = (await ghGet(
          `/repos/${projeto.wingId}/pulls/${depsVigia.numero}`,
          token
        )) as { head?: { sha?: string } }
        currentHeadSha = prDetails?.head?.sha
      }

      if (currentHeadSha) {
        const reviews = (await ghGet(
          `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/reviews?per_page=100`,
          token
        )) as ReviewDoGithub[]

        const review = acharParecerNesteHead(reviews, currentHeadSha)
        if (review) {
          if (ehAprovacao(review)) {
            vereditoDoQa = 'approve'
          } else if (ehReprovacaoCondicional(review)) {
            vereditoDoQa = 'request_changes'
          }

          if (review.body && !ehAprovacao(review)) {
            ultimoParecerQa = {
              body: review.body,
              timestamp: review.submitted_at ? new Date(review.submitted_at) : new Date(0),
            }
          }
        }
      }
    } catch (err) {
      onWarn(
        `decidirAcaoNoPrOrfaoIntegrado: falha ao buscar reviews do PR #${depsVigia.numero}: ${(err as Error).message}`
      )
    }

    if (depsVigia.issueNumber !== null) {
      try {
        const openQuestion = await prisma.agentQuestion.findFirst({
          where: {
            projectId: projeto.id,
            status: 'open',
            dedupKey: { contains: String(depsVigia.issueNumber) },
          },
        })
        temDuvidaPendente = !!openQuestion
      } catch (err) {}
    }

    try {
      const events = await prisma.event.findMany({
        where: {
          projectId: projeto.id,
          type: 'audit',
          payload: { path: ['vigiaDoPr', 'numeroDoPr'], equals: depsVigia.numero },
        },
        orderBy: { createdAt: 'desc' },
      })
      const lastEscalation = events.find(
        (e) =>
          e.payload &&
          typeof e.payload === 'object' &&
          'vigiaDoPr' in e.payload &&
          (e.payload as { vigiaDoPr?: { acao?: string } })['vigiaDoPr']?.acao === 'escalar'
      )
      if (lastEscalation) {
        ultimoEscalonamentoEm = lastEscalation.createdAt
      }
    } catch (err) {}

    if (ultimoParecerQa) {
      try {
        depsVigia.acoesAnteriores = await contarAcoesDoVigia(prisma, {
          projectId: projeto.id,
          numeroDoPr: depsVigia.numero,
          depoisDe: ultimoParecerQa.timestamp,
        })
      } catch (err) {}
    }
  }

  const acaoMotor = decidirProximoPasso({
    ...depsVigia,
    exigeRevisaoDeSeguranca,
    origem,
    cuidaPorOrigem,
    emConstrucaoHa,
    janelaEmConstrucaoHoras,
    entendimentoCompleto,
    vereditoDoQa,
    ultimoParecerQa,
    temDuvidaPendente,
    ultimoEscalonamentoEm,
    diffTruncado,
  })

  // Map AcaoDoMotor to AcaoDoVigia format that vigiarPrsOrfaos expects internally
  if (acaoMotor.acao === 'so-acompanhar') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    return { acao: 'ignorar', motivo: acaoMotor.motivo }
  }
  if (acaoMotor.acao === 'fechar-vazio') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    try {
      const prIndividual = (await ghGet(
        `/repos/${projeto.wingId}/pulls/${depsVigia.numero}`,
        token
      )) as { changed_files?: number }
      if (prIndividual.changed_files === 0) {
        return { acao: 'fechar', motivo: acaoMotor.motivo }
      }
    } catch (err) {
      // Se a API falhar ou não trouxer changed_files, não age destrutivamente
    }
    // Tarefa fechada, mas PR tem arquivos alterados.
    // Em vez de deixar aberto, tratamos como PR substituído.
    return {
      acao: 'fechar',
      motivo: `A tarefa #${depsVigia.issueNumber} já está fechada — ela foi resolvida por outro caminho. Fechando esta entrega, que ficou para trás.`,
    }
  }
  if (acaoMotor.acao === 'perguntar-se-cuida') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )

    if (!onWarn || !depsVigia || depsVigia.numero === undefined || depsVigia.issueNumber === null) {
      return { acao: 'ignorar', motivo: 'tarefa 3.10: dados insuficientes para perguntar' }
    }

    if (!userId || !agentQuestion || !montarContextoExecutivo || !depsDoContexto) {
      onWarn(
        `decidirAcaoNoPrOrfaoIntegrado: sem agentQuestionService ou userId para perguntar se cuida do PR #${depsVigia.numero}`
      )
      return {
        acao: 'ignorar',
        motivo:
          'tarefa 3.10: fluxo de perguntar se cuida pulado porque falta agentQuestionService ou userId',
      }
    }

    try {
      const contexto = await montarContextoExecutivo(
        {
          projectId: projeto.id,
          repository: projeto.wingId,
          issueNumber: depsVigia.issueNumber,
        },
        depsDoContexto
      )

      const fallbackCiState = depsVigia.verificacao || 'unknown'

      // Issue #877: o grafo de vínculos da issue de origem (hierarquia,
      // milestone, campos do quadro, PRs ligados, sessões do Jules, parecer
      // do QA) — best-effort, nunca impede a pergunta de nascer. Só roda
      // quando há issue vinculada (garantido pelo corte no topo deste bloco).
      let historicoGitorch: string[] | undefined
      if (depsVigia.issueNumber !== null) {
        try {
          const contextoDoGrafo = await montarContextoDoItem({
            prisma,
            projectId: projeto.id,
            numero: depsVigia.issueNumber,
          })
          if (contextoDoGrafo) historicoGitorch = contextoDoGrafo.linhas
        } catch (err) {
          onWarn(
            `decidirAcaoNoPrOrfaoIntegrado: falha ao montar contexto do grafo para a issue #${depsVigia.issueNumber}: ${err}`
          )
        }
      }

      await perguntarSeCuida(
        {
          userId,
          projectId: projeto.id,
          numeroDoPr: depsVigia.numero,
          repository: projeto.wingId,
          origem: origem as OrigemDoItem,
          contexto,
          contextoPr: {
            titulo: `PR #${depsVigia.numero}`,
            idadeDias: depsVigia.paradoHaMs
              ? Math.floor(depsVigia.paradoHaMs / (1000 * 60 * 60 * 24))
              : 0,
            idadeTexto: descreverTempoParado(depsVigia.paradoHaMs),
            estadoCi: fallbackCiState,
            conflitos: depsVigia.mergeable === false,
            ...(historicoGitorch ? { historicoGitorch } : {}),
          },
        },
        {
          agentQuestion: agentQuestion as NonNullable<typeof agentQuestion>,
          ...(execute ? { execute } : {}),
          onWarn,
          prisma,
        }
      )
    } catch (err) {
      onWarn(`decidirAcaoNoPrOrfaoIntegrado: erro ao disparar perguntarSeCuida: ${err}`)
    }

    return {
      acao: 'ignorar',
      motivo: 'pergunta executiva "cuido deste pedido?" enviada ao dono',
    }
  }
  if (acaoMotor.acao === 'mesclar') {
    try {
      const baseDoMerge = await lerBaseParaMerge()
      // Imediatamente antes do merge: o commit que o QA aprovou contra o que o
      // PR tem agora. O `sha` do PUT é o vivo, nunca o herdado do começo.
      const cabecaViva = await lerCabecaVivaParaMerge()
      const result: ResultadoDoMerge =
        cabecaViva === null
          ? {
              mesclado: false,
              motivo:
                'não deu para ler o commit atual deste pull request no instante do merge — por segurança não mescla agora',
            }
          : await mesclarPr({
              numeroDoPr: depsVigia.numero,
              ciState: depsVigia.verificacao === 'verde' ? 'green' : 'red',
              vereditoDoQa: vereditoDoQa ?? 'unknown',
              diffTruncado: diffTruncado,
              // A origem real da ficha do PR, não o rótulo: o rótulo da automação
              // basta para o vigia olhar o PR, mas não prova que alguém o encomendou.
              delegado: ehEntregaDoDevAssincrono(origem),
              ...baseDoMerge,
              shaRevisado: currentHeadSha ?? '',
              shaAtual: cabecaViva,
              entendimentoPresente: entendimentoCompleto,
              lerCiAgora: lerCiAgoraParaMerge,
              merge: async () => {
                try {
                  await ghSend(
                    'PUT',
                    `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/merge`,
                    token,
                    {
                      sha: cabecaViva,
                      commit_title: `Merge pull request #${depsVigia.numero} from GitOrch`,
                      commit_message: `Auto-merged by GitOrch (${origem} policy)`,
                    }
                  )
                  return true
                } catch (err) {
                  return false
                }
              },
            })

      if (result.mesclado) {
        // O registro do motor só entra quando a mesclagem de fato acontece:
        // se a trava recusar, o painel mostra a recusa e o motivo, nunca
        // "mesclando".
        await registrarNoPainel(
          projeto.id,
          chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
          `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
        )
        await registrarNoPainel(
          projeto.id,
          `gitorch-merge:${projeto.wingId}:${depsVigia.numero}`,
          `GitOrch: o PR #${depsVigia.numero} foi mesclado com sucesso porque a política manda mesclar sozinho. Issue associada pode ser fechada caso exista.`
        )
        await ghSend(
          'POST',
          `/repos/${projeto.wingId}/issues/${depsVigia.numero}/comments`,
          token,
          { body: `GitOrch: Mesclado com sucesso, critérios batidos.` }
        ).catch(() => {})
        return { acao: 'ignorar', motivo: 'Mesclado com sucesso' }
      } else {
        await registrarNoPainel(
          projeto.id,
          `gitorch-merge-fail:${projeto.wingId}:${depsVigia.numero}`,
          `GitOrch: Falha ao mesclar o PR #${depsVigia.numero}. Motivo: ${result.motivo}`
        )
        return { acao: 'ignorar', motivo: `Falha na mesclagem segura: ${result.motivo}` }
      }
    } catch (err) {
      return { acao: 'ignorar', motivo: `Erro na mesclagem segura: ${(err as Error).message}` }
    }
  }
  if (acaoMotor.acao === 'pedir-julgamento') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    return { acao: 'pedir-julgamento', motivo: acaoMotor.motivo }
  }
  if (acaoMotor.acao === 'retomar') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )

    let finalAcao: ReturnType<typeof decidirProximoPasso> = { ...acaoMotor }

    if (acaoMotor.causa === 'conflito') {
      try {
        const dossie = await montarDossieDoConflito({
          repo: projeto.wingId,
          numeroDoPr: depsVigia.numero,
          issueNumber: depsVigia.issueNumber,
          ghGet: (path: string) => ghGet(path, token),
        })

        if (dossie.conclusao === 'duplicado') {
          return {
            acao: 'fechar',
            motivo: `#${depsVigia.numero}: fechado porque duplica outro PR já mesclado.\n\n${dossie.texto}`,
          }
        } else if (dossie.conclusao === 'escopo_misturado') {
          finalAcao = {
            ...acaoMotor,
            pedido: `A sua entrega tem conflitos de merge e mistura arquivos fora do escopo da tarefa.\n\nPor favor, crie uma nova branch a partir da main e traga apenas o que falta da issue original.\n\n${dossie.texto}`,
          }
        } else {
          finalAcao = {
            ...acaoMotor,
            pedido: `${acaoMotor.pedido}\n\n${dossie.texto}`,
          }
        }
      } catch (err) {
        await registrarNoPainel(
          projeto.id,
          chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, 'erro-dossie'),
          `Falha ao montar dossiê de conflito: ${(err as Error).message}`
        )
      }
    }

    const retomarAcao = finalAcao as typeof acaoMotor

    return {
      acao: 'retomar',
      issueNumber: retomarAcao.issueNumber,
      causa: retomarAcao.causa,
      pedido: retomarAcao.pedido,
      branchDoPr: retomarAcao.branchDoPr,
      motivo: retomarAcao.motivo,
    }
  }
  if (acaoMotor.acao === 'devolver-a-fila') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    return {
      acao: 'devolver-a-fila',
      issueNumber: acaoMotor.issueNumber,
      motivo: acaoMotor.motivo,
    }
  }
  if (acaoMotor.acao === 'escalar') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    return {
      acao: 'ignorar',
      motivo: 'tarefa 3.10: escalonamento ao dono não implementado no scheduler',
    }
  }
  return { acao: 'ignorar', motivo: 'ação do motor desconhecida' }
}
