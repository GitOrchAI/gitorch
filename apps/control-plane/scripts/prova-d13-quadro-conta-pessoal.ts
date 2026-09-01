/**
 * PROVA AO VIVO (D13, 01/09/2026) — roda o MESMO `ensureProjectBoard` do
 * produto (services/onboarding-board.ts), contra a API REAL do GitHub, nos
 * dois cenários do bug:
 *
 *   1) loureng/padrao-executores (conta PESSOAL, repo novo, SEM quadro) —
 *      o `client` (credencial do App) é um DUBLÊ que reproduz o erro real
 *      de produção ("gitorch-ai[bot] does not have permission to create
 *      projects on ownerId U_kgDO..." — colado do journal do dono); o
 *      `criarClienteAlternativo` usa `gh auth token` de verdade (PAT com
 *      escopo repo+project) — o MESMO tipo de credencial que
 *      `lerCredencialDoProjeto` devolveria em produção. Não há como emitir
 *      um installation token real do GitHub App nesta máquina (a chave
 *      privada do App vive só na VM de produção) — por isso o dublê; tudo
 *      o mais (busca, criação, ligação ao repositório) roda contra a API
 *      real, sem mock nenhum.
 *
 *   2) GitOrchAI/gitorch (ORGANIZAÇÃO) — prova que a mudança NÃO quebra o
 *      caminho que já funcionava: aqui não passamos `clientToken` nenhum, só
 *      o client "do App" (aqui, de novo, o token real por falta do
 *      installation token) — se já havia quadro ligado, reusa; não cria
 *      outro.
 *
 * Uso:
 *   pnpm --filter @gitorch/control-plane exec tsx scripts/prova-d13-quadro-conta-pessoal.ts
 * (usa `gh auth token` — precisa do `gh` autenticado como loureng)
 */
import { execFileSync } from 'node:child_process'
import {
  ensureProjectBoard,
  resolveGithubOwnerId,
  resolveGithubRepositoryId,
} from '../src/services/onboarding-board.js'
import { ProjectV2Client } from '@gitorch/github-sync'

function ghAuthToken(): string {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

const TOKEN = ghAuthToken()

/** Dublê da credencial do APP: reproduz o erro real de produção ao tentar
 *  criar quadro (createProjectV2), mas LÊ de verdade contra a API real
 *  (listarQuadrosDoRepositorio) — é assim que o produto de fato se comporta:
 *  o App enxerga leitura via installation token em org, mas nunca em conta
 *  pessoal, e a criação nega nas duas quando falta permissão de Projects. */
function clienteDoAppComPermissaoNegada(
  real: ProjectV2Client
): Pick<
  ProjectV2Client,
  | 'findProjectId'
  | 'createProjectV2'
  | 'linkProjectV2ToRepository'
  | 'listarQuadrosDoRepositorio'
  | 'descobrirQuadrosPorIssues'
  | 'listarQuadrosDaConta'
  | 'detalharQuadro'
> {
  return {
    findProjectId: (args) => real.findProjectId(args),
    listarQuadrosDoRepositorio: (args) => real.listarQuadrosDoRepositorio(args),
    descobrirQuadrosPorIssues: (args) => real.descobrirQuadrosPorIssues(args),
    listarQuadrosDaConta: (args) => real.listarQuadrosDaConta(args),
    detalharQuadro: (args) => real.detalharQuadro(args),
    linkProjectV2ToRepository: (args) => real.linkProjectV2ToRepository(args),
    createProjectV2: async () => {
      throw new Error(
        'GitHub GraphQL request failed: gitorch-ai[bot] does not have permission to create projects on ownerId U_kgDODEJV3w (colado do journal de produção, D13)'
      )
    },
  }
}

async function provaContaPessoal(): Promise<void> {
  console.log('=== CASO 1: loureng/padrao-executores (CONTA PESSOAL, repo sem quadro) ===')
  const repository = 'loureng/padrao-executores'
  const real = new ProjectV2Client({ token: TOKEN })
  const avisos: string[] = []

  const board = await ensureProjectBoard({
    repository,
    client: clienteDoAppComPermissaoNegada(real),
    resolveOwner: (owner) => resolveGithubOwnerId(owner, TOKEN),
    resolveRepositoryId: (repo) => resolveGithubRepositoryId(repo, TOKEN),
    clientToken: TOKEN,
    criarClienteAlternativo: (token) => new ProjectV2Client({ token }),
    onWarn: (m) => avisos.push(m),
  })

  console.log('resultado:', JSON.stringify(board))
  console.log('avisos:', avisos.length ? avisos.join(' | ') : '(nenhum)')

  if (!board) {
    console.log('FALHOU — ensureProjectBoard devolveu null')
    return
  }

  // PROVA FINAL: confere direto na API do GitHub que o quadro nasceu E está
  // ligado ao repositório (não confia só no que a função devolveu).
  const conferido = await real.listarQuadrosDoRepositorio({
    owner: 'loureng',
    repo: 'padrao-executores',
  })
  console.log(
    'conferido via repository.projectsV2 (API real):',
    JSON.stringify(conferido.map((q) => ({ number: q.number, title: q.title, id: q.id })))
  )
}

async function provaOrganizacao(): Promise<void> {
  console.log('')
  console.log('=== CASO 2: GitOrchAI/gitorch (ORGANIZAÇÃO — não pode regredir) ===')
  const repository = 'GitOrchAI/gitorch'
  const real = new ProjectV2Client({ token: TOKEN })
  const avisos: string[] = []

  const board = await ensureProjectBoard({
    repository,
    client: real,
    resolveOwner: (owner) => resolveGithubOwnerId(owner, TOKEN),
    resolveRepositoryId: (repo) => resolveGithubRepositoryId(repo, TOKEN),
    onWarn: (m) => avisos.push(m),
  })

  console.log('resultado:', JSON.stringify(board))
  console.log('avisos:', avisos.length ? avisos.join(' | ') : '(nenhum)')
}

async function main(): Promise<void> {
  await provaContaPessoal()
  await provaOrganizacao()
}

main().catch((err) => {
  console.error('ERRO FATAL:', err)
  process.exit(1)
})
