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
 *
 * Com `--exigir`, inverte esse contrato: sai diferente de zero quando nega. É o
 * modo da reconferência feita segundos antes de mesclar, onde uma negativa
 * precisa abortar o passo. A pergunta é a mesma; o que muda é quem escuta.
 *
 * Por que reconferir: entre a primeira consulta e a mesclagem existe a espera
 * pelo CI, que dura minutos. Nesse intervalo o dev assíncrono pode enviar um
 * commit novo (é o que a automação de CI vermelho manda ele fazer) ou o QA pode
 * mudar de ideia. Perguntar uma vez só faria a aprovação de uma versão liberar
 * outra — exatamente o buraco que este portão existe para fechar.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { Octokit } from '@octokit/rest'
import {
  decidirMerge,
  ehRotinaDeDependencia,
  type RevisaoDoPr,
  type CommitDoPr,
  type EstadoDaRevisao,
} from './lib/merge-gate.js'

/**
 * Login do revisor cuja palavra vale; o App do produto, por padrão.
 *
 * O sufixo `[bot]` faz parte do nome e não é decoração: `gitorch-ai`, sem ele,
 * é um login de pessoa que qualquer um pode registrar. O padrão precisa apontar
 * para a identidade que não dá para falsificar.
 */
const QA_PADRAO = 'gitorch-ai[bot]'

/** Onde o modo reconferência anota a versão que aprovou, para o merge se prender a ela. */
const ARQUIVO_DA_VERSAO = process.env['ARQUIVO_SHA_RECONFERIDO'] ?? '.sha-reconferido'

/** Reconferência de última hora: aqui a negativa precisa abortar o passo. */
const EXIGIR = process.argv.includes('--exigir')

function exigir(nome: string): string {
  const v = process.env[nome]
  if (!v) throw new Error(`variável de ambiente ausente: ${nome}`)
  return v
}

function publicar(pode: boolean, motivo: string): void {
  const saida = process.env['GITHUB_OUTPUT']
  // Na reconferência não se reescreve o resultado da consulta original: aquele
  // output já governou quais passos rodariam, e sobrescrevê-lo agora só
  // confundiria a leitura do que aconteceu.
  if (saida && !EXIGIR) {
    appendFileSync(saida, `pode=${pode ? 'true' : 'false'}\nmotivo=${motivo}\n`)
  }
  console.log(pode ? `✓ portão do QA liberou: ${motivo}` : `✗ portão do QA segurou: ${motivo}`)
  if (!pode) console.log(`::notice title=Merge automático retido::${motivo}`)
  if (!pode && EXIGIR) process.exitCode = 1
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
    // Login inteiro, com o sufixo de robô: é ele que distingue o App do produto
    // de uma conta de pessoa com nome parecido.
    autor: r.user?.login ?? '',
    tipoDeConta: r.user?.type,
    estado: (r.state ?? 'COMMENTED') as EstadoDaRevisao,
    commitId: r.commit_id ?? null,
    em: r.submitted_at ?? new Date(0).toISOString(),
  }))

  // Dispensar o julgamento do QA exige duas coisas: que o robô tenha aberto o
  // pull request E que todo commit do topo seja dele. Quem abriu continua sendo
  // o robô depois que outra pessoa empurra um commit no mesmo ramo; e commits
  // que só se dizem do robô não bastam.
  const commitsBrutos = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  // Só a autoria que a PLATAFORMA reconheceu, nunca o nome escrito dentro do
  // commit. O nome é livre — `git -c user.name=...` aceita qualquer coisa — e,
  // quando o e-mail não pertence a conta nenhuma, é justamente o que sobraria.
  // Ler dali seria decidir quem dispensa o controle de qualidade por um campo
  // que quem comita preenche.
  const commits: CommitDoPr[] = commitsBrutos.map((c) => ({
    autor: c.author?.login ?? null,
    enviadoPor: c.committer?.login ?? null,
  }))

  const exigeAprovacao = !ehRotinaDeDependencia({
    autorDoPr: { login: pr.user?.login ?? '', tipoDeConta: pr.user?.type },
    commits,
  })

  const decisao = decidirMerge({
    revisorDeQualidade,
    revisoes,
    commitAtual: pr.head.sha,
    exigeAprovacao,
  })

  // A mesclagem se prende a esta versão exata. Sem isso, um commit que chegue
  // entre a reconferência e o merge entraria carregado pela decisão que valia
  // para o commit anterior.
  if (decisao.pode) {
    writeFileSync(ARQUIVO_DA_VERSAO, pr.head.sha)
  }

  console.log(
    `PR #${prNumber} · topo ${pr.head.sha.slice(0, 7)} · ` +
      `${revisoes.length} revisão(ões) · ${commits.length} commit(s) · ` +
      `exige aprovação do QA: ${exigeAprovacao}`
  )
  publicar(decisao.pode, decisao.motivo)
}

main().catch((err: unknown) => {
  // Falha ao consultar o portão nunca vira "pode mesclar": na dúvida, segura.
  // `publicar` já decide o código de saída — na reconferência, erro precisa
  // abortar; na consulta inicial, vira aviso e o merge simplesmente não ocorre.
  publicar(false, `não foi possível consultar o veredito do QA (${(err as Error).message})`)
})
