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
  /** 'andando' enquanto a issue está aberta; 'entregue' quando fecha. */
  situacao: 'andando' | 'entregue'
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
export function projetoDaLinha(linha: { name: string; wingId: string }): ProjetoDoDono {
  return { nome: linha.name, repo: linha.wingId }
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
    situacao: issue.state === 'CLOSED' ? 'entregue' : 'andando',
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
