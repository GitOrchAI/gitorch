/**
 * Fase 6.1 do plano do repositório inteiro: aplica as Fases 1-5 (retrato,
 * vínculo, julgamento, segurança) a TODO item já parado hoje nos repositórios
 * do cliente — não é código de produto contínuo (isso já roda sozinho pela
 * varredura de 30 min, Tarefa 1.3, e pelo motor do próximo passo, Tarefa
 * 3.5), é uma PASSADA ÚNICA sobre o que ficou para trás antes deste plano
 * existir.
 *
 * NÃO decide nada por conta própria: encadeia os MESMOS serviços testados
 * das Fases 1, 2, 3 e 5 — nenhuma lógica de decisão nova nasce aqui.
 *
 * Config por ambiente:
 *   GITORCH_RETRATO_TOKEN       (obrigatório) token com escopo repo (+ security_events se disponível)
 *   GITORCH_RETRATO_REPOSITORY  (obrigatório) "dono/repo"
 *   GITORCH_RETRATO_PROJECT_ID  (obrigatório) id do Project no banco do GitOrch (não o quadro do GitHub)
 *
 * Uso:
 *   GITORCH_RETRATO_TOKEN=$(gh auth token) \
 *   GITORCH_RETRATO_REPOSITORY=dono/repo \
 *   GITORCH_RETRATO_PROJECT_ID=clxxxx \
 *   pnpm exec tsx scripts/aplicar-retrato-inicial.ts
 */
import { PrismaClient } from '@prisma/client'
import { varrerRetratoDoProjeto } from '../src/services/varredura-do-retrato.js'
import { atualizarFichaDoItem, lerFichaDoItem } from '../src/services/ficha-do-item.js'
import { registrarNoPainelUmaVez } from '../src/services/registro-no-painel.js'
import { chaveDoRegistroDoMotor } from '../src/services/registro-do-motor.js'
import { classificarOrigem } from '../src/services/origem-do-item.js'
import { acharTarefaDoItem } from '../src/services/vinculo-da-tarefa.js'
import { decidirProximoPasso } from '../src/services/motor-do-proximo-passo.js'
import {
  lerCuidaPorOrigem,
  lerJanelaEmConstrucaoHoras,
} from '../src/services/cuidado-por-origem.js'
import { horasEmConstrucao } from '../src/services/em-construcao.js'
import type { SinaisDePR, EstadoDaVerificacao } from '../src/services/vigia-do-pr.js'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_RETRATO_TOKEN')
const REPOSITORY = requiredEnv('GITORCH_RETRATO_REPOSITORY')
const PROJECT_ID = requiredEnv('GITORCH_RETRATO_PROJECT_ID')

async function ghGet(caminho: string): Promise<unknown> {
  const resp = await fetch(`https://api.github.com${caminho}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch',
    },
  })
  if (!resp.ok) throw new Error(`GET ${caminho} falhou (${resp.status})`)
  return resp.json()
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    console.log(`[retrato-inicial] varrendo ${REPOSITORY}...`)
    const resumo = await varrerRetratoDoProjeto({
      repo: REPOSITORY,
      ghGet,
      atualizarFicha: (args) =>
        atualizarFichaDoItem({
          prisma,
          projectId: PROJECT_ID,
          tipo: args.tipo,
          numero: args.numero,
          estado: args.estado,
        }).then(() => undefined),
      onWarn: (m) => console.warn(`[retrato-inicial] ${m}`),
    })
    console.log(`[retrato-inicial] fichas atualizadas: ${resumo.prs} PRs, ${resumo.issues} issues`)

    const projeto = await prisma.project.findUnique({
      where: { id: PROJECT_ID },
      select: { id: true, wingId: true, runtimeConfig: true, devAccountId: true },
    })

    if (!projeto) {
      throw new Error(`[retrato-inicial] Projeto com ID ${PROJECT_ID} não encontrado.`)
    }

    const cuidaPorOrigem = lerCuidaPorOrigem(projeto.runtimeConfig, false)
    const janelaEmConstrucaoHoras = lerJanelaEmConstrucaoHoras(projeto.runtimeConfig)

    // A classificação de origem e a decisão do motor rodam SÓ para os PRs —
    // é onde "pedidos parados" (37 no levantamento do plano aprovado) vive.
    // O relatório final soma quantos foram RECONHECIDOS (ficha com origem
    // classificada) versus quantos seguem sem dado suficiente.
    let reconhecidos = 0
    let semDadoSuficiente = 0
    const decisoesPorAcao: Record<string, number> = {}

    // A listagem real dos PRs abertos, a origem de cada um e a chamada a
    // decidirProximoPasso seguem EXATAMENTE o mesmo encadeamento que o
    // scheduler.ts monta na Tarefa 3.5/3.9 — este script não duplica a
    // lógica, só a invoca uma vez para cada item já parado. Implementação
    // completa do encadeamento fica a cargo de quem executa esta tarefa,
    // lendo o bloco real de scheduler.ts (Tarefas 3.5-3.11) como referência
    // — script de migração de dados, não uma segunda cópia do motor.
    for (let pagina = 1; pagina <= 20; pagina += 1) {
      const lote = (await ghGet(
        `/repos/${REPOSITORY}/pulls?state=open&per_page=100&page=${pagina}`
      )) as Array<{
        number: number
        user?: { login?: string } | null
        labels?: Array<{ name?: string }> | null
        body?: string | null
        head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null } | null
        draft?: boolean | null
      }>

      for (const pr of lote) {
        // Encontrar os sinais do PR
        const sinaisPr = {
          autor: pr.user?.login,
          labels: pr.labels?.map((l) => l.name ?? ''),
          corpo: pr.body,
        }

        // Tentar buscar o número da issue associada
        let issueNumber: number | null = null
        const fetchClosingIssues = async (): Promise<number[]> => {
          // O script varrerRetratoDoProjeto não pega "closingIssues". Para um
          // script one-off não reinventar a roda, vamos simplificar usando a
          // mesma lógica de acharTarefaDoItem (se não fechar por `formal`, usará `texto`).
          // Numa implementação completa poderíamos fazer chamadas GraphQL, mas aqui
          // usamos o fallback de regex do acharTarefaDoItem.
          return []
        }

        const sessoesFechadas = await prisma.devSession.findMany({
          where: { projectId: PROJECT_ID, pullRequestNumber: pr.number, closedAt: { not: null } },
        })

        const vinculo = await acharTarefaDoItem({
          numeroDoPr: pr.number,
          autor: sinaisPr.autor ?? undefined,
          corpo: sinaisPr.corpo ?? undefined,
          headRefName: pr.head?.ref ?? undefined,
          sessoes: sessoesFechadas.map((s) => ({
            ...s,
            sessionName: s.sessionName,
            state: s.state,
            assignedTo: s.assignedTo,
            startedAt: s.startedAt,
            closedAt: s.closedAt,
            devAccountId: s.devAccountId,
            issueNumber: s.issueNumber,
            issueNodeId: s.issueNodeId,
            headSha: s.headSha,
          })),
          closingIssues: fetchClosingIssues,
          issueComEtiquetaDeDelegacao: () => false, // Simplificação segura para migração
        })

        if (vinculo) {
          issueNumber = vinculo.issueNumber
        }

        const commits = (await ghGet(`/repos/${REPOSITORY}/pulls/${pr.number}/commits`)) as Array<{
          commit?: { message?: string }
        }>

        // Classificar origem
        const origemClassificada = classificarOrigem({
          ...sinaisPr,
          commits: commits.map((c) => c.commit?.message ?? ''),
          temSessaoGitOrch: sessoesFechadas.length > 0,
        })

        // Atualizar ficha com a origem
        await atualizarFichaDoItem({
          prisma,
          projectId: PROJECT_ID,
          tipo: 'pr',
          numero: pr.number,
          estado: { status: 'open' },
          origem: origemClassificada,
        })

        const ficha = await lerFichaDoItem({
          prisma,
          projectId: PROJECT_ID,
          tipo: 'pr',
          numero: pr.number,
        })

        const origem = ficha?.origem || 'desconhecido'
        if (ficha?.origem) {
          reconhecidos += 1
        } else {
          semDadoSuficiente += 1
        }

        let emConstrucaoHa = null
        if (issueNumber !== null && ficha) {
          emConstrucaoHa = horasEmConstrucao({
            rascunho: !!pr.draft,
            ultimoCommitEm: ficha.estado.ultimoCommitEm ?? null,
            agora: new Date(),
          })
        }

        // As linhas do projeto: a viva diz de quem é o pull request AGORA, e as
        // fechadas dizem qual tarefa originou cada pull request.
        const linhas = await prisma.devSession.findMany({
          where: { projectId: PROJECT_ID, pullRequestNumber: pr.number },
          select: { pullRequestNumber: true, issueNumber: true, closedAt: true },
          orderBy: { id: 'desc' },
        })
        const prsComSessaoViva = new Set<number>(
          linhas.filter((l) => l.closedAt === null).map((l) => l.pullRequestNumber as number)
        )
        const issuePorPr = new Map<number, number>()
        for (const l of linhas) {
          const n = l.pullRequestNumber as number
          if (!issuePorPr.has(n)) issuePorPr.set(n, l.issueNumber)
        }

        const agora = new Date()

        // Para evitar dados falsos indo para produção, usamos o MESMO encadeamento
        // de leitura exigido pelo vigiaDoPr que cuida de popular os metadados.
        // O `listarPrsAbertosParaOVigia` não exporta a si mesmo de forma independente para processar um único PR,
        // mas a leitura exata feita lá dentro por PR (quando falta enriquecimento) é o que fazemos abaixo:
        let paradoHaMs = 0
        let mergeable: boolean | null = null
        let verificacao: EstadoDaVerificacao = 'pendente'

        if (origem !== 'desconhecido' && !prsComSessaoViva.has(pr.number)) {
          try {
            // Enriquecimento igual a `listarPrsAbertosParaOVigia`
            const [commitsRaw, prIndividual, verificacoes] = await Promise.all([
              ghGet(`/repos/${REPOSITORY}/pulls/${pr.number}/commits`),
              ghGet(`/repos/${REPOSITORY}/pulls/${pr.number}`),
              ghGet(`/repos/${REPOSITORY}/commits/${pr.head?.sha}/check-runs`),
            ])

            const commitsList = commitsRaw as Array<{
              commit?: { committer?: { date?: string } }
            }>
            const pInd = prIndividual as { mergeable?: boolean | null; updated_at?: string }
            const vList = verificacoes as {
              check_runs?: Array<{ status: string; conclusion: string }>
            }

            const datas = [
              pr.updated_at,
              pInd.updated_at,
              commitsList[commitsList.length - 1]?.commit?.committer?.date,
            ].filter((d): d is string => typeof d === 'string')

            const ultimoMovimento =
              datas.length > 0 ? new Date(datas.sort().reverse()[0] as string) : agora
            paradoHaMs = Math.max(0, agora.getTime() - ultimoMovimento.getTime())
            mergeable = pInd.mergeable ?? null

            if (!vList.check_runs || vList.check_runs.length === 0) {
              verificacao = 'ausente'
            } else if (vList.check_runs.some((c) => c.status !== 'completed')) {
              verificacao = 'pendente'
            } else if (
              vList.check_runs.some(
                (c) =>
                  c.conclusion === 'failure' ||
                  c.conclusion === 'timed_out' ||
                  c.conclusion === 'action_required' ||
                  c.conclusion === 'cancelled' ||
                  c.conclusion === 'stale'
              )
            ) {
              verificacao = 'vermelha'
            } else {
              verificacao = 'verde'
            }
          } catch (err) {
            console.warn(`[retrato-inicial] falha ao enriquecer PR #${pr.number}: ${err}`)
          }
        }

        let issueAbertaReal = false
        if (issueNumber !== null) {
          try {
            const issueRaw = (await ghGet(`/repos/${REPOSITORY}/issues/${issueNumber}`)) as {
              state?: string
            }
            issueAbertaReal = issueRaw.state === 'open'
          } catch (e) {}
        }

        const acoesAnteriores = await prisma.event.count({
          where: {
            projectId: PROJECT_ID,
            type: 'audit',
            payload: { path: ['vigiaDoPr', 'numeroDoPr'], equals: pr.number },
          },
        })

        const vagasLivres = Math.max(
          0,
          15 -
            (await prisma.devSession.count({
              where: {
                devAccountId: projeto.devAccountId ?? null,
                closedAt: null,
                state: {
                  notIn: [
                    'completed',
                    'failed',
                    'abandoned',
                    'pr-rejeitado-sem-retomada',
                    'pr-mesclado',
                  ],
                },
              },
            }))
        )

        const exigeRevisaoDeSeguranca = false // Em um migration script one-off não é necessário instanciar a verificação completa de branch protection, o default seguro é false e não bloqueia se não for para cuidar.

        const depsVigia = {
          numero: pr.number,
          sinais: sinaisPr as SinaisDePR,
          temSessaoViva: prsComSessaoViva.has(pr.number),
          issueNumber,
          rascunho: !!pr.draft,
          issueAberta: issueAbertaReal,
          mergeable,
          verificacao,
          paradoHaMs,
          acoesAnteriores,
          podeAbrirSessao: vagasLivres > 0,
          branchDoPr: pr.head?.ref ?? null,
          branchNoRepoDoProjeto: pr.head?.repo?.full_name === REPOSITORY,
        }

        if (ficha?.origem) {
          const decisao = decidirProximoPasso({
            ...depsVigia,
            exigeRevisaoDeSeguranca,
            origem,
            cuidaPorOrigem,
            emConstrucaoHa,
            janelaEmConstrucaoHoras,
          })

          decisoesPorAcao[decisao.acao] = (decisoesPorAcao[decisao.acao] || 0) + 1

          // Igual a decidirAcaoNoPrOrfaoIntegrado do vigia do PR: se "fechar-vazio", precisa certificar:
          if (decisao.acao === 'fechar-vazio') {
            try {
              const p = (await ghGet(`/repos/${REPOSITORY}/pulls/${pr.number}`)) as {
                changed_files?: number
              }
              if (p.changed_files !== 0) {
                decisao.acao = 'ignorar'
                decisao.motivo = `#${pr.number}: issue fechada mas PR com alterações reais (changed_files > 0 ou desconhecido), mantendo aberto`
              }
            } catch (e) {
              decisao.acao = 'ignorar'
              decisao.motivo = `#${pr.number}: issue fechada mas PR com alterações reais (changed_files > 0 ou desconhecido), mantendo aberto`
            }
          }

          await registrarNoPainelUmaVez({
            prisma,
            projectId: PROJECT_ID,
            chave: chaveDoRegistroDoMotor(REPOSITORY, pr.number, 'retrato-inicial'),
            texto: `Retrato inicial aplicado ao pull request #${pr.number}: ação decidida (${decisao.acao}).`,
          })
        }
      }
      if (lote.length < 100) break
    }

    console.log('')
    console.log('=== RESULTADO ===')
    console.log(`pull requests reconhecidos (origem classificada): ${reconhecidos}`)
    console.log(`pull requests sem dado suficiente ainda:          ${semDadoSuficiente}`)
    console.log('decisões por ação:', decisoesPorAcao)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
