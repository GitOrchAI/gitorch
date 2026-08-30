// O que o GitOrch vê quando o cliente acaba de plugar um repositório.
//
// Pergunta do dono (29/08): "o cliente acabou de por repositorio no gitorch, o
// gitorch começa a ler sobre — como vai ser feito esse pensamento?"
//
// A resposta desta camada é deliberadamente humilde: ela CONTA o que está lá,
// não julga. Quantos pedidos abertos, quantas entregas paradas, se há quadro,
// se o quadro tem sprint, se há verificação automática, em que linguagem está
// escrito. Nada de nota, nem de "saúde do repositório", nem de estimativa —
// diagnóstico inventado é pior que diagnóstico nenhum, e o dono já barrou
// número que ninguém definiu.
//
// A consulta foi disparada de verdade antes desta camada existir (29/08, com a
// credencial do próprio dono):
//   GitOrchAI/gitorch        → 72 pedidos abertos, 19 entregas abertas,
//                              1 quadro vivo SEM campo de sprint, TypeScript,
//                              ramo main, 9 verificações
//   loureng/patinhas-3d-crafts → 97 pedidos, 6 entregas, 2 quadros (1
//                              arquivado), G-code
// E o repositório inexistente devolveu HTTP 200 com `repository: null` mais um
// `errors` de NOT_FOUND — por isso o corpo é tratado, e não só o status.
//
// Só LEITURA. Escrever no repositório do cliente passa pela guarda de
// autonomia, e é outro caminho.

import type { ProjetoDoDono } from './arvore-de-pedidos.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'

/** A leitura de UM repositório que respondeu. */
export interface RepositorioLido {
  /** Nome que o dono vê. */
  projeto: string
  /** "owner/repo". */
  repo: string
  disponivel: true
  privado: boolean
  /** Linguagem principal segundo o GitHub. `null` quando ele não sabe dizer. */
  linguagem: string | null
  /** Issues abertas. É o que o dono chama de "pedidos". */
  pedidosAbertos: number
  /** Pull requests abertos. É o que o dono chama de "entregas". */
  entregasAbertas: number
  quadros: {
    total: number
    /** Não arquivados — os únicos que servem para alguma coisa. */
    vivos: number
    /** Quantos dos vivos têm campo de sprint COM ciclos configurados. */
    comSprint: number
    /**
     * O GitHub disse que existem quadros mas NÃO deixou ver quais.
     *
     * Acontece em repositório de conta pessoal: o App não enxerga Projects V2
     * lá, e a resposta vem com `totalCount: 2` e os nós FORBIDDEN. Sem este
     * campo, `vivos: 0` diria "você não tem quadro" para quem tem dois — a
     * mentira exata que este painel veio acabar.
     */
    naoConsigoVer: boolean
  }
  /** Ramo principal. `null` em repositório ainda sem nenhum commit. */
  ramoPrincipal: string | null
  /**
   * Há verificação automática rodando no último commit do ramo principal.
   * É a pergunta "tem CI?" respondida por evidência, não por existir um
   * arquivo de workflow no disco — arquivo parado não verifica nada.
   */
  temVerificacao: boolean
  /** Data do último commit no ramo principal (ISO), ou `null`. */
  ultimoCommit: string | null
}

/** A leitura de um repositório que NÃO respondeu. */
export interface RepositorioIndisponivel {
  projeto: string
  repo: string
  disponivel: false
  /**
   * Em português, para o dono ler. Nunca "0" — repositório sem acesso mostrado
   * como zero é uma mentira pequena que faz ele achar que o repositório está
   * vazio.
   */
  motivo: string
}

export type LeituraDeProjeto = RepositorioLido | RepositorioIndisponivel

/**
 * Não deu para ler NENHUM repositório.
 *
 * Mesmo desenho da árvore de pedidos: separa "não consegui ler" de "não há
 * nada para ler". Os dois viravam lista vazia, e a tela mentia.
 */
export class LeituraIndisponivelError extends Error {
  constructor(motivo: string) {
    super(`LEITURA_INDISPONIVEL: ${motivo}`)
    this.name = 'LeituraIndisponivelError'
  }
}

export interface DepsDaLeitura {
  listarProjetos: (ownerId: string) => Promise<ProjetoDoDono[]>
  lerToken: (ownerId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
}

const CONSULTA = `
query LeituraDoRepositorio($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    isPrivate
    primaryLanguage { name }
    issues(states: OPEN) { totalCount }
    pullRequests(states: OPEN) { totalCount }
    projectsV2(first: 10) {
      totalCount
      nodes {
        id
        number
        title
        closed
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2IterationField {
              name
              configuration { iterations { id } }
            }
          }
        }
      }
    }
    defaultBranchRef {
      name
      target { ... on Commit { committedDate checkSuites(first: 1) { totalCount } } }
    }
  }
}`

interface QuadroBruto {
  closed?: boolean
  fields?: {
    nodes?: Array<{
      __typename?: string
      configuration?: { iterations?: unknown[] } | null
    } | null>
  } | null
}

interface RepositorioBruto {
  isPrivate?: boolean
  primaryLanguage?: { name?: string } | null
  issues?: { totalCount?: number }
  pullRequests?: { totalCount?: number }
  projectsV2?: { totalCount?: number; nodes?: Array<QuadroBruto | null> } | null
  defaultBranchRef?: {
    name?: string
    target?: { committedDate?: string; checkSuites?: { totalCount?: number } } | null
  } | null
}

/** "owner/repo" → as duas metades; `null` quando o endereço não tem forma. */
function partirRepo(repo: string): { owner: string; name: string } | null {
  const [owner, name, ...resto] = repo.split('/')
  if (!owner || !name || resto.length > 0) return null
  return { owner, name }
}

/**
 * Conta os quadros do jeito que importa.
 *
 * Arquivado não conta como vivo: escrever sprint num quadro fechado é escrever
 * no vazio (a mesma regra de `resolver-quadro.ts`). E "tem sprint" exige
 * ciclos DE VERDADE — o quadro do Jardim tinha o campo criado com duração
 * zero e nenhuma iteração: existia e não funcionava.
 */
export function contarQuadros(
  nodes: ReadonlyArray<QuadroBruto | null>,
  /** O que o GitHub DECLAROU existir, mesmo sem deixar ver. */
  totalDeclarado?: number
): {
  total: number
  vivos: number
  comSprint: number
  naoConsigoVer: boolean
} {
  const reais = nodes.filter((n): n is QuadroBruto => n !== null && n !== undefined)
  const vivos = reais.filter((q) => q.closed !== true)
  const comSprint = vivos.filter((q) =>
    (q.fields?.nodes ?? []).some(
      (f) =>
        f?.__typename === 'ProjectV2IterationField' &&
        (f.configuration?.iterations?.length ?? 0) > 0
    )
  )
  // O GitHub declarou mais quadros do que deixou ver: dizer o total declarado
  // e avisar que a contagem dos vivos não dá para fazer é mais honesto que
  // mostrar zero.
  const declarado = totalDeclarado ?? reais.length
  return {
    total: Math.max(declarado, reais.length),
    vivos: vivos.length,
    comSprint: comSprint.length,
    naoConsigoVer: declarado > reais.length,
  }
}

/** Traduz a resposta crua do GitHub para a leitura que a tela mostra. */
export function paraLeitura(bruto: RepositorioBruto, projeto: ProjetoDoDono): RepositorioLido {
  const ramo = bruto.defaultBranchRef
  return {
    projeto: projeto.nome,
    repo: projeto.repo,
    disponivel: true,
    privado: bruto.isPrivate === true,
    linguagem: bruto.primaryLanguage?.name ?? null,
    pedidosAbertos: bruto.issues?.totalCount ?? 0,
    entregasAbertas: bruto.pullRequests?.totalCount ?? 0,
    quadros: contarQuadros(bruto.projectsV2?.nodes ?? [], bruto.projectsV2?.totalCount),
    ramoPrincipal: ramo?.name ?? null,
    temVerificacao: (ramo?.target?.checkSuites?.totalCount ?? 0) > 0,
    ultimoCommit: ramo?.target?.committedDate ?? null,
  }
}

/**
 * Lê os repositórios do dono — todos, ou um só.
 *
 * Um repositório que falha NÃO derruba os outros: ele entra na lista como
 * indisponível, com o motivo, e os que responderam aparecem normalmente. Só
 * quando NENHUM responde a leitura inteira vira erro.
 */
export async function lerRepositorios(
  deps: DepsDaLeitura,
  args: { ownerId: string; projeto?: string | undefined }
): Promise<LeituraDeProjeto[]> {
  // `fetchSemPermissao` e nao `fetch` cru mesmo aqui, que so LE: a guarda
  // deixa leitura passar, e ter o mesmo padrao em todo lugar tira o julgamento
  // caso a caso — no dia em que alguem acrescentar uma escrita neste arquivo,
  // ela ja nasce barrada em vez de vazar por um `?? fetch` esquecido.
  const f = deps.fetchImpl ?? fetchSemPermissao()
  const todos = await deps.listarProjetos(args.ownerId)
  const projetos = args.projeto ? todos.filter((p) => p.nome === args.projeto) : todos
  if (projetos.length === 0) return []

  const token = await deps.lerToken(args.ownerId)
  if (!token) throw new LeituraIndisponivelError('sem credencial do dono')

  const leituras: LeituraDeProjeto[] = []

  for (const projeto of projetos) {
    const alvo = partirRepo(projeto.repo)
    if (!alvo) {
      leituras.push(
        indisponivel(projeto, 'o endereço do repositório não está no formato dono/repositório')
      )
      continue
    }
    try {
      const resposta = await f('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          authorization: `token ${token}`,
          'content-type': 'application/json',
          'user-agent': 'gitorch',
        },
        body: JSON.stringify({
          query: CONSULTA,
          variables: { owner: alvo.owner, name: alvo.name },
        }),
      })
      if (!resposta.ok) {
        leituras.push(indisponivel(projeto, `o GitHub respondeu ${resposta.status}`))
        continue
      }
      // 200 não quer dizer que deu certo: repositório inexistente ou sem
      // acesso volta com `repository: null` e um `errors` no CORPO. Medido ao
      // vivo em 29/08.
      const corpo = (await resposta.json()) as {
        data?: { repository?: RepositorioBruto | null } | null
        errors?: Array<{ message?: string }>
      }
      // ERRO PARCIAL NAO E LEITURA IMPOSSIVEL.
      //
      // Medido com a credencial real do dono em 30/08: loureng/patinhas-3d-crafts
      // responde 200 com o repositorio PRESENTE — 97 pedidos, 6 entregas, 2
      // quadros — e dois `errors` FORBIDDEN so nos NOS dos quadros (o App nao
      // enxerga quadro de conta pessoal). A versao anterior derrubava a leitura
      // inteira por causa disso e mostrava "nao consegui ler" para um
      // repositorio de onde 97 pedidos tinham acabado de chegar.
      //
      // Agora `errors` so derruba quando o repositorio NAO veio. Com ele
      // presente, vale o que chegou.
      if (!corpo.data?.repository) {
        leituras.push(
          indisponivel(
            projeto,
            'não consegui abrir este repositório — ele pode ter sido removido, renomeado, ou o acesso saiu'
          )
        )
        continue
      }
      leituras.push(paraLeitura(corpo.data.repository, projeto))
    } catch {
      leituras.push(indisponivel(projeto, 'não consegui falar com o GitHub agora'))
    }
  }

  // Todos falharam: não é "o dono não tem nada", é "não deu para ler".
  if (leituras.length > 0 && leituras.every((l) => !l.disponivel)) {
    throw new LeituraIndisponivelError('nenhum repositório respondeu')
  }

  return leituras
}

function indisponivel(projeto: ProjetoDoDono, motivo: string): RepositorioIndisponivel {
  return { projeto: projeto.nome, repo: projeto.repo, disponivel: false, motivo }
}
