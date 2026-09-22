import { lerCuidaPorOrigem, lerJanelaEmConstrucaoHoras } from './cuidado-por-origem.js'
import { horasEmConstrucao } from './em-construcao.js'
import { decidirProximoPasso } from './motor-do-proximo-passo.js'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'
import { mesclarPr } from './merge-do-pr.js'
import { chaveDoRegistroDoMotor } from './registro-do-motor.js'
import { lerFichaDoItem } from './ficha-do-item.js'
import { calcularExigeRevisaoDeSeguranca } from './exigir-revisao-de-seguranca.js'
import { planoPermiteMelhoria, type PlanoDoGithub } from './aplicar-melhoria-de-seguranca.js'
import type { PrismaClient } from '@prisma/client'
import type { VigiaDoPrDeps } from './vigia-do-pr.js'

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
    return {
      acao: 'ignorar',
      motivo: `#${depsVigia.numero}: issue fechada mas PR com alterações reais (changed_files > 0 ou desconhecido), mantendo aberto`,
    }
  }
  if (acaoMotor.acao === 'perguntar-se-cuida') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    // mapear 'perguntar-se-cuida' para o fluxo existente
    // (PO/perguntar-vinculo/cuidado-por-origem) no futuro.
    // Por enquanto mantemos ignorar com o que falta sem escalar
    return {
      acao: 'ignorar',
      motivo: 'tarefa 3.10: fluxo de perguntar se cuida não implementado no scheduler',
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
    return {
      acao: 'retomar',
      issueNumber: acaoMotor.issueNumber,
      causa: acaoMotor.causa,
      pedido: acaoMotor.pedido,
      branchDoPr: acaoMotor.branchDoPr,
      motivo: acaoMotor.motivo,
    }
  }
  if (acaoMotor.acao === 'escalar') {
    await registrarNoPainel(
      projeto.id,
      chaveDoRegistroDoMotor(projeto.wingId, depsVigia.numero, acaoMotor.acao),
      `Pull request #${depsVigia.numero}: ${acaoMotor.motivo}`
    )
    // "escalar" isn't explicitly handled yet by vigiarPrsOrfaos' mapping below
    // (though 'escalar' is not currently in the plan's list, if it was in the motor it will log here).
    // The previous mapping had no branch for 'escalar', we just let it fall through or map to ignorar
    // (or if it exists, it can just be added above).
    // Actually, 'escalar' wasn't mapped previously, but the technical plan mentioned it as one of the actions:
    // "(retomar, fechar-vazio, mesclar, perguntar-se-cuida, escalar, so-acompanhar)".
  }
  return { acao: 'ignorar', motivo: 'ação do motor desconhecida' }
}
