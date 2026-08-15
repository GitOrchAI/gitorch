import { mintInstallationToken } from './github-app-token.js'
import { GithubExecutionError } from './github-errors.js'

// Escreve a issue de desejo no repositório do cliente.
//
// Vive num serviço próprio porque tem DOIS chamadores — a tela (rota HTTP) e o
// mensageiro (bot do Telegram) — e o pedido do dono tem de nascer exatamente
// igual venha de onde vier. Duas cópias desta chamada divergiriam em silêncio,
// e o dono descobriria pela issue errada.

export interface RegistroDeFalha {
  onError?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

/**
 * A credencial que escreve no repositório do cliente: a instalação do App
 * RESOLVIDA PELO REPOSITÓRIO. Sem passar o repositório, o App emite o token da
 * primeira instalação da lista — de outra conta — e toda escrita volta 403.
 */
async function tokenDoRepositorio(repo: string, log: RegistroDeFalha): Promise<string | null> {
  const doAmbiente = process.env['GITORCH_GITHUB_TOKEN']
  if (doAmbiente) return doAmbiente
  return mintInstallationToken({
    repository: repo,
    ...(log.onError ? { onError: log.onError } : {}),
    ...(log.onWarn ? { onWarn: log.onWarn } : {}),
  })
}

export async function criarIssueDeDesejo(args: {
  repo: string
  titulo: string
  corpo: string
  etiquetas: string[]
  log?: RegistroDeFalha
  /** Injetados nos testes; em produção, a credencial real e o fetch real. */
  obterToken?: (repo: string) => Promise<string | null>
  fetchImpl?: typeof fetch
}): Promise<{ numero: number }> {
  const log = args.log ?? {}
  const obter = args.obterToken ?? ((repo: string) => tokenDoRepositorio(repo, log))
  const f = args.fetchImpl ?? fetch

  const token = await obter(args.repo)
  if (!token) {
    throw new GithubExecutionError(`sem credencial do GitHub para o repositório ${args.repo}`)
  }

  const resposta = await f(`https://api.github.com/repos/${args.repo}/issues`, {
    method: 'POST',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'gitorch',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: args.titulo, body: args.corpo, labels: args.etiquetas }),
  })
  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '')
    throw new GithubExecutionError(
      `GitHub POST /repos/${args.repo}/issues falhou (${resposta.status}): ${detalhe.slice(0, 150)}`
    )
  }

  const criada = (await resposta.json()) as { number?: number }
  if (typeof criada.number !== 'number') {
    // Sem número não há issue para o dono abrir: dar isto como sucesso seria
    // prometer um registro que ninguém consegue achar depois.
    throw new GithubExecutionError(`GitHub criou a issue em ${args.repo} sem devolver o número`)
  }
  return { numero: criada.number }
}
