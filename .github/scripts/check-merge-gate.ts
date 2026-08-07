/**
 * Consulta o portão de merge e publica a decisão para o workflow.
 *
 * Roda entre "o CI está verde" e "mesclar": busca as revisões do pull request e
 * pergunta ao portão se a palavra do QA autoriza a mesclagem desta versão.
 * Escreve `pode` e `motivo` no GITHUB_OUTPUT — quem age é o workflow.
 *
 * Sai com código zero mesmo quando nega: reprovação do QA não é falha de
 * infraestrutura e não deve pintar o pull request de vermelho como se o CI
 * tivesse quebrado. A negativa aparece como aviso, com o motivo.
 */

import { appendFileSync } from 'node:fs'
import { Octokit } from '@octokit/rest'
import { decidirMerge, type RevisaoDoPr, type EstadoDaRevisao } from './lib/merge-gate.js'

/** Login do revisor cuja palavra vale; o App do produto, por padrão. */
const QA_PADRAO = 'gitorch-ai'

function exigir(nome: string): string {
  const v = process.env[nome]
  if (!v) throw new Error(`variável de ambiente ausente: ${nome}`)
  return v
}

function publicar(pode: boolean, motivo: string): void {
  const saida = process.env['GITHUB_OUTPUT']
  if (saida) {
    appendFileSync(saida, `pode=${pode ? 'true' : 'false'}\nmotivo=${motivo}\n`)
  }
  console.log(pode ? `✓ portão do QA liberou: ${motivo}` : `✗ portão do QA segurou: ${motivo}`)
  if (!pode) console.log(`::notice title=Merge automático retido::${motivo}`)
}

async function main(): Promise<void> {
  const owner = exigir('REPO_OWNER')
  const repo = exigir('REPO_NAME')
  const prNumber = Number(exigir('PR_NUMBER'))
  const revisorDeQualidade = process.env['QA_REVIEWER'] || QA_PADRAO

  const octokit = new Octokit({ auth: exigir('GITHUB_TOKEN') })

  const pr = (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data
  const revisoesBrutas = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  const revisoes: RevisaoDoPr[] = revisoesBrutas.map((r) => ({
    // O App revisa como "gitorch-ai[bot]"; o sufixo é detalhe da plataforma e
    // não deve obrigar quem configura a decorá-lo.
    autor: (r.user?.login ?? '').replace(/\[bot\]$/, ''),
    estado: (r.state ?? 'COMMENTED') as EstadoDaRevisao,
    commitId: r.commit_id ?? null,
    em: r.submitted_at ?? new Date(0).toISOString(),
  }))

  // Dentro do que já é elegível, quem não é rotina de dependência é código
  // escrito pelo dev assíncrono — e esse não entra sem o QA aprovar. O autor do
  // pull request do dev sai como a pessoa que conectou a conta, então "não é o
  // robô de dependências" é justamente o teste certo aqui.
  const exigeAprovacao = pr.user?.login !== 'dependabot[bot]'

  const decisao = decidirMerge({
    revisorDeQualidade,
    revisoes,
    commitAtual: pr.head.sha,
    exigeAprovacao,
  })

  console.log(
    `PR #${prNumber} · topo ${pr.head.sha.slice(0, 7)} · ` +
      `${revisoes.length} revisão(ões) · exige aprovação do QA: ${exigeAprovacao}`
  )
  publicar(decisao.pode, decisao.motivo)
}

main().catch((err: unknown) => {
  // Falha ao consultar o portão nunca vira "pode mesclar": na dúvida, segura.
  const motivo = `não foi possível consultar o veredito do QA (${(err as Error).message})`
  publicar(false, motivo)
  process.exitCode = 0
})
