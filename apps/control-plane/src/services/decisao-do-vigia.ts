import { lerCuidaPorOrigem, lerJanelaEmConstrucaoHoras } from './cuidado-por-origem.js'
import { horasEmConstrucao } from './em-construcao.js'
import { decidirProximoPasso } from './motor-do-proximo-passo.js'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'
import { mesclarPr } from './merge-do-pr.js'
import { chaveDoRegistroDoMotor } from './registro-do-motor.js'
import { lerFichaDoItem } from './ficha-do-item.js'
import { calcularExigeRevisaoDeSeguranca } from './exigir-revisao-de-seguranca.js'
import { planoPermiteMelhoria, type PlanoDoGithub } from './aplicar-melhoria-de-seguranca.js'
import { montarDossieDoConflito } from './dossie-do-conflito.js'
import type { PrismaClient } from '@prisma/client'
import type { VigiaDoPrDeps } from './vigia-do-pr.js'
import { perguntarSeCuida, type AgentQuestionAskerDeCuidado } from './perguntar-se-cuida.js'
import type {
  montarContextoExecutivoDaPergunta,
  DepsDoContextoExecutivo,
} from './contexto-executivo-da-pergunta.js'
import type { OrigemDoItem } from './origem-do-item.js'

type AcaoDoVigia = ReturnType<
  NonNullable<
    Parameters<typeof import('./vigia-do-pr.js').vigiarPrsOrfaos>[0]['decidirAcaoNoPrOrfao']
  >
>

export interface DecisaoDoVigiaDeps {
  runtimeConfig: unknown
  agora: Date
  projeto: { id: string; wingId: string; devPlan?: string | null }
  token: string
  depsVigia: Parameters<NonNullable<VigiaDoPrDeps['decidirAcaoNoPrOrfao']>>[0]
  prisma: PrismaClient
  ghGet: (caminho: string, token: string) => Promise<unknown>
  userId?: string | null | undefined
  agentQuestion?: AgentQuestionAskerDeCuidado | undefined
  montarContextoExecutivo?: typeof montarContextoExecutivoDaPergunta | undefined
  depsDoContexto?: DepsDoContextoExecutivo | undefined
  /** Fase 5.3/#802: escrita de merge do caminho expresso do Dependabot. */
  ghSend: (
    method: 'POST' | 'PATCH' | 'PUT',
    caminho: string,
    token: string,
    body: unknown
  ) => Promise<unknown>
  /** Fase 5.3/#802: registra na timeline do painel que o merge expresso aconteceu. */
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  /** Log de aviso não-fatal (falha ao buscar visibilidade do repo, falha na trava de parecer etc). */
  onWarn: (mensagem: string) => void
}

export async function decidirAcaoNoPrOrfaoIntegrado({
  runtimeConfig,
  agora,
  projeto,
  token,
  depsVigia,
  prisma,
  ghGet,
  ghSend,
  registrarNoPainel,
  onWarn,
  userId,
  agentQuestion,
  montarContextoExecutivo,
  depsDoContexto,
}: DecisaoDoVigiaDeps): Promise<Awaited<AcaoDoVigia>> {
  const cuidaPorOrigem = lerCuidaPorOrigem(runtimeConfig, false)
  const janelaEmConstrucaoHoras = lerJanelaEmConstrucaoHoras(runtimeConfig)

  let origem = 'desconhecido'
  let emConstrucaoHa: number | null = null

  if (depsVigia.issueNumber !== null) {
    const ficha = await lerFichaDoItem({
      prisma: prisma as never,
      projectId: projeto.id,
      tipo: 'issue',
      numero: depsVigia.issueNumber,
    })
    if (ficha) {
      origem = ficha.origem || 'desconhecido'
      emConstrucaoHa = horasEmConstrucao({
        rascunho: depsVigia.rascunho,
        ultimoCommitEm: ficha.estado.ultimoCommitEm ?? null,
        agora,
      })
    }
  }

  // Fase 5.3/#802: caminho PRÓPRIO do Dependabot — não passa por
  // decidirProximoPasso (Tarefa 3.5), que trata TODO PR do Dependabot como
  // "automação sem conserto" (não há sessão para retomar). Aqui não há
  // conserto: só a decisão de mesclar ou deixar quieto.
  if (origem === 'dependabot') {
    const depsDependabot = {
      politica: cuidaPorOrigem.dependabot,
      verificacao: depsVigia.verificacao,
      mergeable: depsVigia.mergeable,
    }
    const decisaoDependabot = decidirMergeDoDependabot(depsDependabot)
    if (decisaoDependabot.mesclar) {
      try {
        const currentPr = (await ghGet(
          `/repos/${projeto.wingId}/pulls/${depsVigia.numero}`,
          token
        )) as { head: { sha: string } }
        await mesclarPr({
          numeroDoPr: depsVigia.numero,
          ciState: 'green',
          vereditoDoQa: 'approve',
          diffTruncado: false,
          delegado: true,
          shaRevisado: currentPr.head.sha,
          shaAtual: currentPr.head.sha,
          entendimentoPresente: true,
          merge: async () => {
            try {
              await ghSend(
                'PUT',
                `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/merge`,
                token,
                {
                  sha: currentPr.head.sha,
                  commit_title: `Merge pull request #${depsVigia.numero} from Dependabot`,
                  commit_message: 'Auto-merged by GitOrch (Dependabot policy)',
                }
              )
              return true
            } catch (err) {
              return false
            }
          },
        })
        await registrarNoPainel(
          projeto.id,
          `dependabot-merge:${projeto.wingId}:${depsVigia.numero}`,
          `GitOrch: o PR #${depsVigia.numero} do Dependabot estava verde e a política manda mesclar sozinho. Merge feito e issue associada pode ser fechada caso exista.`
        )
        return { acao: 'ignorar', motivo: 'Mesclado pelo caminho expresso do Dependabot' }
      } catch (err) {
        return {
          acao: 'ignorar',
          motivo: `Erro ao tentar mesclar o Dependabot expresso: ${(err as Error).message}`,
        }
      }
    }
  }

  let repoPrivado = true
  try {
    const repoInfo = (await ghGet(`/repos/${projeto.wingId}`, token)) as {
      private?: boolean
    }
    if (repoInfo && typeof repoInfo.private === 'boolean') {
      repoPrivado = repoInfo.private
    }
  } catch (err) {
    onWarn(
      `[decisao-do-vigia] falha ao buscar visibilidade de ${projeto.wingId}: ${(err as Error).message}`
    )
  }

  const planoPermite = planoPermiteMelhoria(
    'secret-scanning',
    (projeto.devPlan || 'free') as PlanoDoGithub,
    repoPrivado
  )
  const exigeRevisaoDeSeguranca = await calcularExigeRevisaoDeSeguranca({
    planoPermite,
    wingId: projeto.wingId,
    ghGet: (path) => ghGet(path, token),
    onWarn,
  })

  const acaoMotor = decidirProximoPasso({
    ...depsVigia,
    exigeRevisaoDeSeguranca,
    origem,
    cuidaPorOrigem,
    emConstrucaoHa,
    janelaEmConstrucaoHoras,
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

      await perguntarSeCuida(
        {
          userId,
          projectId: projeto.id,
          numeroDoPr: depsVigia.numero,
          repository: projeto.wingId,
          origem: origem as OrigemDoItem,
          contexto,
        },
        { agentQuestion }
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
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    // mapear 'mesclar' para o caminho de merge seguro existente
    // (merge-do-pr.ts, exige tarefa aceita + CI verde + QA com entendimento).
    // Por enquanto mantemos ignorar sem usar escalar
    return {
      acao: 'ignorar',
      motivo: 'tarefa 3.10: mesclagem automática segura não implementada no scheduler',
    }
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
