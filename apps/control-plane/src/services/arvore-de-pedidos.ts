import { ETIQUETA_DE_DESEJO } from './desejo.js'

// A árvore dos pedidos, para o painel do owner (leva 2, bloco 2).
//
// O desejo do dono já vira issue no GitHub com a etiqueta `wishlist`
// (services/desejo.ts), e o Produto pendura a árvore embaixo dela —
// fases → épicos → features → tasks — como sub-issues. Tudo isso JÁ EXISTE no
// repositório do cliente; o painel é que nunca leu de volta e mostrava exemplo.
//
// A consulta foi disparada de verdade contra a API antes desta camada existir
// (29/08, repo GitOrchAI/gitorch): devolveu 5 pedidos, entre eles um com 1 de 3
// partes concluídas e um com 0 de 0 — o desejo que ainda não virou árvore.
// Coleção reexecutável no Postman: "GitOrch — arvore de pedidos do painel".
//
// Só LEITURA. Escrever no repositório do cliente é outro bloco.

/** Um pedido do dono, do jeito que a tela mostra. */
export interface PedidoDoPainel {
  numero: number
  titulo: string
  /**
   * O estado da ISSUE no GitHub: 'andando' enquanto aberta, 'fechado' quando
   * fechada. NÃO é "entregue".
   *
   * Este campo já se chamou 'entregue', e era mentira: uma issue fecha por
   * muitos motivos — duplicada, cancelada, fechada à mão, resolvida fora do
   * produto — e nenhum deles passa pela régua de pronto do cliente. Quem
   * responde "isto ficou pronto?" é `avaliarPronto` (packages/cadence) sobre
   * os fatos de `dev_sessions`, e o resultado vive na aba Entregas. Aqui só
   * cabe dizer o fato que a leitura realmente tem: a issue está fechada.
   */
  situacao: 'andando' | 'fechado'
  /** Nome do projeto — nunca o id: o painel não expõe id de projeto. */
  projeto: string
  /** Quando o dono pediu (ISO). */
  quando: string
  endereco: string
  /**
   * Andamento vindo de `subIssuesSummary` do próprio GitHub: quantos filhos
   * diretos já fecharam. Um desejo ainda sem árvore devolve 0 de 0 — a tela
   * mostra isso como "ainda sendo planejado", nunca como 0% de progresso.
   */
  partes: { total: number; concluidas: number }
}

export interface ProjetoDoDono {
  /** Nome que o dono vê. */
  nome: string
  /** "owner/repo". */
  repo: string
  /**
   * Id do projeto no banco. Necessário para achar a credencial DELE: o
   * aplicativo do produto não enxerga quadro de conta pessoal, e nesses casos
   * vale a credencial que o cliente guardou. Opcional porque nem todo chamador
   * precisa dela.
   */
  id?: string
}

/**
 * Traduz a linha do banco para o que a leitura da árvore precisa.
 *
 * ATENÇÃO ao par de campos — já custou um 503 em produção (29/08):
 *   `wingId` = "owner/repo", o ENDEREÇO do repositório no GitHub.
 *   `name`   = o nome curto que o dono vê ("gitorch").
 * O comentário do schema que diz "owner/repo" fica logo acima de `wingId`;
 * quem lê rápido acha que é do `name` e manda "gitorch" para a API — sem
 * barra, a consulta nunca resolve e TODOS os projetos falham de uma vez.
 */
export function projetoDaLinha(linha: {
  name: string
  wingId: string
  id?: string
}): ProjetoDoDono {
  return { nome: linha.name, repo: linha.wingId, ...(linha.id ? { id: linha.id } : {}) }
}

export interface DepsDaArvoreDePedidos {
  /** Projetos do dono, já filtrados por userId. */
  listarProjetos: (ownerId: string) => Promise<ProjetoDoDono[]>
  /** Credencial do dono. `null` quando não há cofre montado. */
  lerToken: (ownerId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
}

interface IssueBruta {
  number?: number
  title?: string
  state?: string
  createdAt?: string
  url?: string
  subIssuesSummary?: { total?: number; completed?: number } | null
}

const CONSULTA = `
query Pedidos($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, labels: [$label], orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number title state createdAt url subIssuesSummary { total completed } }
    }
  }
}`

/**
 * Um nó da árvore embaixo do pedido: fase, épico, feature ou task — o mesmo
 * shape em todo nível, porque `addSubIssue` (backlog-executor.ts) pendura
 * cada um do mesmo jeito nativo do GitHub.
 */
export interface NoDaArvore {
  numero: number
  titulo: string
  /** Mesma regra do pedido: é o estado da ISSUE, nunca "entregue". */
  situacao: 'andando' | 'fechado'
  endereco: string
  /**
   * Quantos filhos diretos o GitHub reporta (`subIssuesSummary`) e quantos já
   * fecharam. PODE ser maior que `filhos.length`: a consulta tem um teto por
   * nível (ver CONSULTA_ARVORE) e um nó com mais filhos do que o teto chega
   * aqui com `partes.total` maior — a tela é que decide como avisar que não
   * trouxe todos, nunca finge que viu a lista inteira.
   */
  partes: { total: number; concluidas: number }
  /** Os filhos que a consulta conseguiu trazer, já como nós da árvore. Task
   *  (o último nível que a consulta desce) sempre chega com `filhos: []` —
   *  não é "sem filhos de verdade", é "não perguntei mais um nível". */
  filhos: NoDaArvore[]
}

/**
 * Não achei o pedido nem o nível que a consulta pediu.
 *
 * Duas causas viram ESTE erro, de propósito: o projeto não é do dono (ele
 * poderia estar tentando o número de outro cliente) e o número não existe
 * naquele repositório. As duas merecem 404, nunca 503 — não é "não consegui
 * ler agora", é "isso que você pediu não existe". `ArvoreIndisponivelError`
 * continua reservado para quando a leitura em si falhou (rede, GitHub fora do
 * ar, sem credencial).
 */
export class PedidoNaoEncontradoError extends Error {
  constructor(motivo: string) {
    super(`PEDIDO_NAO_ENCONTRADO: ${motivo}`)
    this.name = 'PedidoNaoEncontradoError'
  }
}

/**
 * Um nó bruto, do jeito que o GraphQL devolve dentro de `subIssues.nodes` —
 * recursivo porque a consulta pendura o MESMO campo em cada nível (ver
 * CONSULTA_ARVORE). O último nível pedido não tem `subIssues` no corpo: o
 * campo chega `undefined`, e `noDaSubIssue` trata isso como "sem filhos",
 * nunca como erro.
 */
interface SubIssueBruta {
  number?: number
  title?: string
  state?: string
  url?: string
  subIssuesSummary?: { total?: number; completed?: number } | null
  subIssues?: { nodes?: (SubIssueBruta | null)[] } | null
}

/**
 * fase → épico → feature → task, um `subIssues` aninhado por nível.
 *
 * OS TETOS SÃO DE PROPÓSITO, não arredondados no olho: o limite de nós de uma
 * consulta GraphQL do GitHub é o PRODUTO dos `first` de cada nível aninhado
 * (documentado, não hipótese). Com `20 × 20 × 20 × 50 = 400.000` a consulta
 * fica sob o teto de 500.000 mesmo no pior caso — mas um pedido real nunca
 * tem 20 fases; o teto generoso é para o nível mais raso nunca cortar, e o
 * `50` no de tasks é o nível que o dono descreveu como "dezenas". Cortar
 * SEM avisar seria o mesmo defeito que este bloco existe para consertar: a
 * árvore mentindo que viu tudo. Por isso cada nível também pede
 * `subIssuesSummary` — é o que deixa `NoDaArvore.partes.total` maior que
 * `filhos.length` quando o teto cortou, em vez de escantear em silêncio.
 */
const CONSULTA_ARVORE = `
query ArvoreDoPedido($owner: String!, $name: String!, $numero: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $numero) {
      subIssues(first: 20) {
        nodes {
          number title state url
          subIssuesSummary { total completed }
          subIssues(first: 20) {
            nodes {
              number title state url
              subIssuesSummary { total completed }
              subIssues(first: 20) {
                nodes {
                  number title state url
                  subIssuesSummary { total completed }
                  subIssues(first: 50) {
                    nodes { number title state url subIssuesSummary { total completed } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`

/**
 * Não deu para ler a árvore.
 *
 * Existe para a rota separar "não consegui ler" de "o dono não pediu nada".
 * Os dois viravam lista vazia, e aí a tela mentia: dizia que não havia pedido
 * enquanto o GitHub estava fora do ar.
 */
export class ArvoreIndisponivelError extends Error {
  constructor(motivo: string) {
    super(`ARVORE_INDISPONIVEL: ${motivo}`)
    this.name = 'ArvoreIndisponivelError'
  }
}

/** "owner/repo" → as duas metades; `null` quando o endereço não tem forma. */
function partirRepo(repo: string): { owner: string; name: string } | null {
  const [owner, name, ...resto] = repo.split('/')
  if (!owner || !name || resto.length > 0) return null
  return { owner, name }
}

function paraPedido(issue: IssueBruta, projeto: string): PedidoDoPainel | null {
  if (typeof issue.number !== 'number') return null
  const s = issue.subIssuesSummary
  return {
    numero: issue.number,
    titulo: issue.title ?? '(sem título)',
    // Fechada é fechada. Anunciar "Entregue" a partir daqui declararia pronto
    // algo que nunca foi julgado pela régua do cliente.
    situacao: issue.state === 'CLOSED' ? 'fechado' : 'andando',
    projeto,
    quando: issue.createdAt ?? '',
    endereco: issue.url ?? '',
    partes: { total: s?.total ?? 0, concluidas: s?.completed ?? 0 },
  }
}

/**
 * Lê os pedidos do dono em todos os projetos dele, ou em um só.
 *
 * Um projeto que falha NÃO derruba os outros: o dono com cinco repositórios
 * continua vendo os quatro que responderam. Só quando NENHUM responde a
 * leitura vira indisponível — aí a tela diz que não conseguiu ler, em vez de
 * inventar uma lista vazia.
 */
export async function lerArvoreDePedidos(
  deps: DepsDaArvoreDePedidos,
  args: { ownerId: string; projeto?: string | undefined }
): Promise<PedidoDoPainel[]> {
  const f = deps.fetchImpl ?? fetch
  const todos = await deps.listarProjetos(args.ownerId)
  const projetos = args.projeto ? todos.filter((p) => p.nome === args.projeto) : todos
  if (projetos.length === 0) return []

  const token = await deps.lerToken(args.ownerId)
  if (!token) throw new ArvoreIndisponivelError('sem credencial do dono')

  const pedidos: PedidoDoPainel[] = []
  let falharam = 0

  for (const projeto of projetos) {
    const alvo = partirRepo(projeto.repo)
    if (!alvo) {
      falharam++
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
          variables: { owner: alvo.owner, name: alvo.name, label: ETIQUETA_DE_DESEJO },
        }),
      })
      if (!resposta.ok) {
        falharam++
        continue
      }
      // O GitHub responde 200 e sinaliza no CORPO: repositório que não existe
      // (ou sem acesso) volta com `repository: null` ou com `errors`. Tratar só
      // o status deixaria o produto achar que o repositório está vazio.
      const corpo = (await resposta.json()) as {
        data?: { repository?: { issues?: { nodes?: IssueBruta[] } } | null } | null
        errors?: unknown[]
      }
      if (corpo.errors?.length || !corpo.data?.repository) {
        falharam++
        continue
      }
      for (const issue of corpo.data.repository.issues?.nodes ?? []) {
        const pedido = issue && paraPedido(issue, projeto.nome)
        if (pedido) pedidos.push(pedido)
      }
    } catch {
      // Rede caiu neste projeto. O erro do GitHub NUNCA é repassado adiante:
      // pode carregar credencial no texto.
      falharam++
    }
  }

  if (falharam === projetos.length) {
    throw new ArvoreIndisponivelError('nenhum projeto respondeu')
  }
  // Mais recente primeiro, atravessando projetos.
  return pedidos.sort((a, b) => b.quando.localeCompare(a.quando))
}

/** Um nó bruto de `subIssues.nodes` → `NoDaArvore`, descendo recursivamente. */
function noDaSubIssue(bruto: SubIssueBruta): NoDaArvore | null {
  if (typeof bruto.number !== 'number') return null
  const s = bruto.subIssuesSummary
  const filhos = (bruto.subIssues?.nodes ?? [])
    .map((f) => (f ? noDaSubIssue(f) : null))
    .filter((n): n is NoDaArvore => n !== null)
  return {
    numero: bruto.number,
    titulo: bruto.title ?? '(sem título)',
    situacao: bruto.state === 'CLOSED' ? 'fechado' : 'andando',
    endereco: bruto.url ?? '',
    partes: { total: s?.total ?? 0, concluidas: s?.completed ?? 0 },
    filhos,
  }
}

/**
 * Lê a árvore de UM pedido — fase → épico → feature → task — pendurada
 * embaixo dele no GitHub.
 *
 * Chamada só quando o dono expande a linha do pedido na tela (nunca junto da
 * lista): a lista cobre até 50 pedidos de uma vez, e pendurar a árvore
 * inteira de cada um estouraria o teto de nós do GraphQL do GitHub muito
 * antes de chegar em qualquer fase (ver o comentário de CONSULTA_ARVORE).
 * Buscar sob demanda, um pedido por vez, é o que deixa os tetos de cada
 * nível serem generosos sem violar esse teto.
 */
export async function lerArvoreDoPedido(
  deps: DepsDaArvoreDePedidos,
  args: { ownerId: string; projeto: string; numero: number }
): Promise<NoDaArvore[]> {
  const f = deps.fetchImpl ?? fetch
  const todos = await deps.listarProjetos(args.ownerId)
  const projeto = todos.find((p) => p.nome === args.projeto)
  // Projeto que o dono não tem: MESMA família de defeito que o `numero`
  // errado — 404, e nunca chega a pedir a credencial dele à toa.
  if (!projeto) throw new PedidoNaoEncontradoError('projeto não encontrado')

  const alvo = partirRepo(projeto.repo)
  if (!alvo) throw new ArvoreIndisponivelError('endereço do repositório sem forma')

  const token = await deps.lerToken(args.ownerId)
  if (!token) throw new ArvoreIndisponivelError('sem credencial do dono')

  try {
    const resposta = await f('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `token ${token}`,
        'content-type': 'application/json',
        'user-agent': 'gitorch',
      },
      body: JSON.stringify({
        query: CONSULTA_ARVORE,
        variables: { owner: alvo.owner, name: alvo.name, numero: args.numero },
      }),
    })
    if (!resposta.ok) throw new ArvoreIndisponivelError('GitHub respondeu com erro')

    const corpo = (await resposta.json()) as {
      data?: {
        repository?: { issue?: { subIssues?: { nodes?: (SubIssueBruta | null)[] } } | null } | null
      } | null
      errors?: unknown[]
    }
    if (corpo.errors?.length || !corpo.data?.repository) {
      throw new ArvoreIndisponivelError('não consegui ler o repositório')
    }
    const issue = corpo.data.repository.issue
    // O repositório respondeu, mas ESTE número não existe nele — diferente de
    // "não consegui ler o repositório inteiro".
    if (!issue) throw new PedidoNaoEncontradoError('pedido não encontrado no repositório')

    return (issue.subIssues?.nodes ?? [])
      .map((n) => (n ? noDaSubIssue(n) : null))
      .filter((n): n is NoDaArvore => n !== null)
  } catch (err) {
    // Já eram os erros de domínio que este serviço decidiu levantar —
    // deixa passar. Qualquer outra coisa (rede caiu, JSON quebrado) vira
    // ArvoreIndisponivelError: o erro cru do fetch NUNCA é repassado adiante,
    // porque pode carregar a credencial no texto.
    if (err instanceof ArvoreIndisponivelError || err instanceof PedidoNaoEncontradoError) throw err
    throw new ArvoreIndisponivelError('rede caiu')
  }
}
