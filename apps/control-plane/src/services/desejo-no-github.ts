import { ProjectV2Client } from '@gitorch/github-sync'
import { mintInstallationToken } from './github-app-token.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { GithubExecutionError } from './github-errors.js'
import { nomeDeRepositorioValido } from './nome-de-repositorio.js'
import { anexarAoQuadro, criarGqlDoGithub } from './anexar-ao-quadro.js'

/** Prazo da chamada ao GitHub: a API fora do ar não segura a rota para sempre. */
const TIMEOUT_MS = 10_000

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
  /**
   * L4-T8: quadro do cliente para pendurar a issue recém-criada, best-effort.
   * AUSENTE = repositório sem quadro resolvido para este chamador — a issue
   * nasce sem card, exatamente como sempre nasceu até aqui (nenhuma mudança
   * de comportamento para quem não passa este campo).
   *
   * `boardToken` é a credencial de QUEM ESCREVE no quadro — em conta pessoal
   * só a credencial do PRÓPRIO cliente alcança Projects V2 (D12, medido em
   * board-status.ts/resolver-quadro.ts). Ausente cai no MESMO token que criou
   * a issue (o caso comum de conta de organização).
   */
  quadro?: { projectId: string; boardToken?: string }
}): Promise<{ numero: number }> {
  const log = args.log ?? {}
  const obter = args.obterToken ?? ((repo: string) => tokenDoRepositorio(repo, log))
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = args.fetchImpl ?? fetchSemPermissao()

  // Primeira coisa que acontece aqui, antes de existir credencial em memória:
  // o repositório vai colado numa URL que carrega o token, então um texto
  // fora do formato não é "nome estranho" — é o poder de escolher qual
  // endereço da API recebe a credencial. Recusar sem tocar rede é a guarda.
  if (!nomeDeRepositorioValido(args.repo)) {
    throw new GithubExecutionError(
      `repositório em formato inválido, não é "dono/repositorio": ${JSON.stringify(args.repo).slice(0, 80)}`
    )
  }

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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '')
    throw new GithubExecutionError(
      `GitHub POST /repos/${args.repo}/issues falhou (${resposta.status}): ${detalhe.slice(0, 150)}`
    )
  }

  const criada = (await resposta.json()) as { number?: number; node_id?: string }
  if (typeof criada.number !== 'number') {
    // Sem número não há issue para o dono abrir: dar isto como sucesso seria
    // prometer um registro que ninguém consegue achar depois.
    throw new GithubExecutionError(`GitHub criou a issue em ${args.repo} sem devolver o número`)
  }

  // L4-T8: pendura no quadro, best-effort. NUNCA desfaz a issue que já
  // nasceu — falhar em silêncio aqui seria mascarar; falhar a issue inteira
  // por causa do CARD seria pior ainda (o dono perderia o pedido por um
  // problema no board). Usa o `node_id` que a própria criação já devolveu —
  // sem lookup extra — e o MESMO `f` (a guarda de autonomia já resolvida
  // acima: quem chamou sem `fetchImpl` cai no `fetchSemPermissao`, que recusa
  // toda escrita, o anexo incluído).
  if (args.quadro && criada.node_id) {
    try {
      const tokenDoQuadro = args.quadro.boardToken ?? token
      const client = new ProjectV2Client({ token: tokenDoQuadro, fetchImpl: f })
      const gql = criarGqlDoGithub(f, tokenDoQuadro)
      await anexarAoQuadro(
        { projectId: args.quadro.projectId, issueNodeId: criada.node_id },
        { client, gql }
      )
    } catch (err) {
      log.onWarn?.(
        `não anexei a issue #${criada.number} de ${args.repo} ao quadro (${String(err).slice(0, 150)})`
      )
    }
  }

  return { numero: criada.number }
}
