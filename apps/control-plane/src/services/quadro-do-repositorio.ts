import { ProjectV2Client } from '@gitorch/github-sync'
import { fetchComTeto } from './fetch-com-teto.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { decidirQuadro } from './resolver-quadro.js'
import { anexarAoQuadro, criarGqlDoGithub } from './anexar-ao-quadro.js'
import {
  lerCredencialQueAlcancaOProjeto,
  type LeitorDeCredencialDeLogin,
} from './project-credential.js'

// L4-T8 (fix-up) — o caminho ÚNICO de "qual quadro (Projects v2) e qual
// credencial ESTE repositório usa".
//
// Extraído de `varrerIssuesForaDoQuadroDosProjetos` (plugins/scheduler.ts):
// os 4 nascimentos de desejo (routes/index.ts, plugins/telegram.ts,
// plugins/scheduler.ts×2) e a issue de incidente (`ghIssue`, também em
// scheduler.ts) precisam da MESMA resposta, e cada um reimplementando o
// trio por conta própria é exatamente o tipo de divergência que a lição do
// SSRF (guarda espalhada é guarda furada) já avisou. A partir desta task, a
// própria varredura passa a chamar isto também — uma fonte só.
//
// O trio nunca muda: a credencial que ALCANÇA o projeto
// (`lerCredencialQueAlcancaOProjeto` — nunca uma resolução nova de
// credencial), os quadros do repositório (`listarQuadrosDoRepositorio`) e a
// decisão entre eles (`decidirQuadro`, resolver-quadro.ts). Listar quadros é
// LEITURA — nunca precisa de guarda de autonomia; só ESCREVER no quadro
// (anexar-ao-quadro.ts) exige o `fetch` com o nível do projeto, e isso
// continua responsabilidade de quem chama.

/** O recorte mínimo de Prisma que este serviço precisa para achar o
 *  repositório e o dono de um projeto — e nada mais. */
export interface PrismaLikeParaQuadro {
  project: {
    findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<{
      wingId?: string | null
      userId?: string | null
      encryptedClientToken?: string | null
    } | null>
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
  }
}

export interface DepsDoResolverQuadro {
  prisma: PrismaLikeParaQuadro
  /** Injeção; produção passa `app.engineConnections`. Ausência (scripts,
   *  testes) resolve em "sem reforço", nunca lança — mesmo contrato de
   *  `lerCredencialQueAlcancaOProjeto`. */
  engineConnections?: LeitorDeCredencialDeLogin
  /** Só os testes trocam. Em produção lê com o MESMO `fetch` sem permissão
   *  de escrita que a varredura já usava — listar quadro é leitura, nunca
   *  passa pela guarda de autonomia (ela só existe para escrita). */
  fetchImpl?: typeof fetch
}

/**
 * Duas formas de perguntar "qual o quadro deste repositório":
 *
 *  - `{ projectId }`: o caso comum, um projeto do GitOrch. Busca o
 *    repositório e o dono no banco e resolve a credencial pelo caminho
 *    único (`lerCredencialQueAlcancaOProjeto`).
 *  - `{ repo, token }`: repositório SEM projeto no banco — o repositório do
 *    próprio produto (`GITORCH_SELF_REPO`), que a issue de incidente também
 *    pode usar. Quem chama já tem a credencial certa (o installation token
 *    do produto) e só quer a mesma decisão de quadro, sem inventar uma
 *    segunda forma de decidir.
 */
export type ArgsDoResolverQuadro = { projectId: string } | { repo: string; token: string }

export interface QuadroResolvido {
  /** O node id do quadro (Projects v2) — o `projectId` que `anexarAoQuadro`
   *  e `criarIssueDeDesejo({ quadro })` esperam. O nome é repetido de
   *  propósito: é como o resto do produto já chama o board do GitHub. */
  projectId: string
  /** A credencial que ALCANÇA este quadro. Em conta pessoal só a do próprio
   *  cliente serve (D12); em organização, a mesma que listou os quadros. */
  boardToken: string
}

export interface ResultadoDoResolverQuadro {
  quadro: QuadroResolvido | null
  /** Presente sempre que `quadro` é nulo — por que não há decisão 'usar'. */
  motivo?: string
}

const TIMEOUT_DE_LEITURA_MS = 10_000

/**
 * Qual quadro (Projects v2) e qual credencial este repositório usa.
 *
 * NUNCA lança: qualquer falha (banco fora do ar, GitHub instável, sem
 * credencial, sem quadro decidido) devolve `{ quadro: null, motivo }` — quem
 * chama decide, best-effort, se a issue nasce sem card. Nunca loga nem
 * devolve o token fora de `boardToken`.
 */
export async function resolverQuadroDoRepositorio(
  args: ArgsDoResolverQuadro,
  deps: DepsDoResolverQuadro
): Promise<ResultadoDoResolverQuadro> {
  let repo: string
  let token: string

  if ('projectId' in args) {
    let projeto: { wingId?: string | null; userId?: string | null } | null
    try {
      projeto = await deps.prisma.project.findUnique({
        where: { id: args.projectId },
        select: { wingId: true, userId: true },
      })
    } catch (err) {
      return {
        quadro: null,
        motivo: `não consegui ler o projeto para achar o repositório (${String(err).slice(0, 120)})`,
      }
    }
    if (!projeto?.wingId) {
      return { quadro: null, motivo: 'projeto não encontrado ou sem repositório' }
    }
    repo = projeto.wingId

    const obtido = await lerCredencialQueAlcancaOProjeto({
      prisma: deps.prisma,
      projectId: args.projectId,
      userId: projeto.userId ?? null,
      ...(deps.engineConnections ? { engineConnections: deps.engineConnections } : {}),
    })
    if (!obtido) {
      return { quadro: null, motivo: 'não há credencial que alcance este repositório' }
    }
    token = obtido
  } else {
    repo = args.repo
    token = args.token
  }

  const [owner, name] = repo.split('/')
  if (!owner || !name) {
    return { quadro: null, motivo: `repositório fora do formato dono/repo: ${repo}` }
  }

  try {
    const leitor = new ProjectV2Client({
      token,
      fetchImpl: deps.fetchImpl ?? fetchComTeto(fetchSemPermissao(), TIMEOUT_DE_LEITURA_MS),
    })
    const quadros = await leitor.listarQuadrosDoRepositorio({ owner, repo: name })
    const decisao = decidirQuadro({ candidatos: quadros.map((q) => ({ ...q, linkado: true })) })
    if (decisao.acao !== 'usar' || !decisao.quadro) {
      return { quadro: null, motivo: decisao.motivo }
    }
    return { quadro: { projectId: decisao.quadro.id, boardToken: token } }
  } catch (err) {
    return {
      quadro: null,
      motivo: `não consegui listar os quadros de ${repo} (${String(err).slice(0, 120)})`,
    }
  }
}

/**
 * O atalho comum aos 4 nascimentos de desejo (routes/index.ts,
 * plugins/telegram.ts, plugins/scheduler.ts×2): resolve o quadro do projeto
 * e devolve exatamente o formato que `criarIssueDeDesejo({ quadro })`
 * espera — ou `undefined`, com um log informativo, quando não há decisão
 * 'usar'. Best-effort de propósito: a issue nasce igual, com ou sem card, e
 * NUNCA lança — um projeto sem quadro resolvido não pode derrubar a
 * criação da issue de desejo.
 */
export async function resolverQuadroParaDesejo(
  args: { projectId: string; repo: string },
  deps: DepsDoResolverQuadro & { onInfo?: (mensagem: string) => void }
): Promise<{ projectId: string; boardToken: string } | undefined> {
  const resolvido = await resolverQuadroDoRepositorio({ projectId: args.projectId }, deps)
  if (!resolvido.quadro) {
    deps.onInfo?.(
      `quadro não decidido para ${args.repo}: ${resolvido.motivo ?? 'motivo desconhecido'}`
    )
    return undefined
  }
  return resolvido.quadro
}

export interface DepsDeAnexarIncidenteAoQuadro extends DepsDoResolverQuadro {
  /** `fetch` para ESCREVER no quadro do CLIENTE — carrega a guarda de
   *  autonomia DAQUELE projeto (nunca `ghComGuarda`/`guardaPorRepositorio`:
   *  GraphQL não carrega o repositório na URL, então essa guarda não tem
   *  como descobrir de quem é a chamada e recusaria sempre). */
  fetchDeEscritaNoCliente: typeof fetch
  /** `fetch` para ESCREVER no quadro do PRÓPRIO PRODUTO — é a nossa casa,
   *  sem guarda de cliente nenhuma (mesma isenção que `nossosRepositorios`
   *  já dá à escrita REST em guarda-de-autonomia.ts). */
  fetchDeEscritaNoProduto: typeof fetch
  onInfo?: (mensagem: string) => void
  /** Recebe a mensagem PRONTA (com o número da issue e o repo) e o erro
   *  original — nunca o token, nunca detalhe de rede não filtrado. */
  onWarn?: (mensagem: string, err: unknown) => void
}

/**
 * O `ghIssue` do incidente (plugins/scheduler.ts) usa isto DEPOIS de criar a
 * issue: pendura no quadro do repositório onde ela nasceu — o do CLIENTE ou
 * o do PRÓPRIO PRODUTO (`ehORepoDoProduto`, sem `Project` no banco — quem
 * chama já tem a credencial certa). Usa o `node_id` que a criação já
 * devolveu, sem lookup extra.
 *
 * NUNCA lança: nem a ausência de quadro decidido, nem a falha ao anexar
 * derrubam a issue que já nasceu — o pior caso é ela nascer sem card, e isso
 * vira log (`onInfo`/`onWarn`), nunca exceção.
 */
export async function anexarIssueDeIncidenteAoQuadro(
  args: {
    repo: string
    issueNodeId: string
    issueNumber: number
    /** Quando `true`, `repo` é o repositório do PRÓPRIO produto — sem
     *  `Project` no banco; `token` já é a credencial certa. Quando `false`,
     *  `projectId` é obrigatório. */
    ehORepoDoProduto: boolean
    projectId?: string
    token: string
  },
  deps: DepsDeAnexarIncidenteAoQuadro
): Promise<void> {
  try {
    const resolvido =
      args.ehORepoDoProduto || !args.projectId
        ? await resolverQuadroDoRepositorio({ repo: args.repo, token: args.token }, deps)
        : await resolverQuadroDoRepositorio({ projectId: args.projectId }, deps)

    if (!resolvido.quadro) {
      deps.onInfo?.(
        `quadro não decidido para ${args.repo}: ${resolvido.motivo ?? 'motivo desconhecido'}`
      )
      return
    }

    const fetchDoAnexo = args.ehORepoDoProduto
      ? deps.fetchDeEscritaNoProduto
      : deps.fetchDeEscritaNoCliente
    const gql = criarGqlDoGithub(fetchDoAnexo, resolvido.quadro.boardToken)
    const client = new ProjectV2Client({
      token: resolvido.quadro.boardToken,
      fetchImpl: fetchDoAnexo,
    })
    await anexarAoQuadro(
      { projectId: resolvido.quadro.projectId, issueNodeId: args.issueNodeId },
      { client, gql }
    )
  } catch (err) {
    deps.onWarn?.(`não anexei a issue #${args.issueNumber} de ${args.repo} ao quadro`, err)
  }
}
