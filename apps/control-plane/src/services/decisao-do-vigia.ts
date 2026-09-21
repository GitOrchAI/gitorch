import { lerCuidaPorOrigem, lerJanelaEmConstrucaoHoras } from './cuidado-por-origem.js'
import { decidirProximoPasso } from './motor-do-proximo-passo.js'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'
import { mesclarPr } from './merge-do-pr.js'
import { lerFichaDoItem } from './ficha-do-item.js'
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
  projeto: { id: string; wingId: string }
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
      if (ficha.estado.rascunho || ficha.estado.ultimoCommitEm) {
        try {
          const prCommits = (await ghGet(
            `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/commits`,
            token
          )) as Array<{
            commit?: { author?: { date?: string }; committer?: { date?: string } }
          }>
          if (prCommits && prCommits.length > 0) {
            const lastCommit = prCommits[prCommits.length - 1]
            if (lastCommit) {
              const dateStr = lastCommit.commit?.committer?.date || lastCommit.commit?.author?.date
              if (dateStr) {
                const date = Date.parse(dateStr)
                if (!Number.isNaN(date)) {
                  emConstrucaoHa = (agora.getTime() - date) / (1000 * 60 * 60)
                }
              }
            }
          }
        } catch (err) {
          // Se a API falhar, emConstrucaoHa fica null para rebaixar
          // a inação segura em decidirProximoPasso.
        }
      }
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
              await ghSend('PUT', `/repos/${projeto.wingId}/pulls/${depsVigia.numero}/merge`, token, {
                sha: currentPr.head.sha,
                commit_title: `Merge pull request #${depsVigia.numero} from Dependabot`,
                commit_message: 'Auto-merged by GitOrch (Dependabot policy)',
              })
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

  const acaoMotor = decidirProximoPasso({
    ...depsVigia,
    origem,
    cuidaPorOrigem,
    emConstrucaoHa,
    janelaEmConstrucaoHoras,
  })

  // Map AcaoDoMotor to AcaoDoVigia format that vigiarPrsOrfaos expects internally
  if (acaoMotor.acao === 'so-acompanhar') {
    return { acao: 'ignorar', motivo: acaoMotor.motivo }
  }
  if (acaoMotor.acao === 'fechar-vazio') {
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
    // mapear 'perguntar-se-cuida' para o fluxo existente
    // (PO/perguntar-vinculo/cuidado-por-origem) no futuro.
    // Por enquanto mantemos ignorar com o que falta sem escalar
    return {
      acao: 'ignorar',
      motivo: 'tarefa 3.10: fluxo de perguntar se cuida não implementado no scheduler',
    }
  }
  if (acaoMotor.acao === 'mesclar') {
    // mapear 'mesclar' para o caminho de merge seguro existente
    // (merge-do-pr.ts, exige tarefa aceita + CI verde + QA com entendimento).
    // Por enquanto mantemos ignorar sem usar escalar
    return {
      acao: 'ignorar',
      motivo: 'tarefa 3.10: mesclagem automática segura não implementada no scheduler',
    }
  }
  if (acaoMotor.acao === 'retomar') {
    return {
      acao: 'retomar',
      issueNumber: acaoMotor.issueNumber,
      causa: acaoMotor.causa,
      pedido: acaoMotor.pedido,
      branchDoPr: acaoMotor.branchDoPr,
      motivo: acaoMotor.motivo,
    }
  }
  return { acao: 'ignorar', motivo: 'ação do motor desconhecida' }
}
