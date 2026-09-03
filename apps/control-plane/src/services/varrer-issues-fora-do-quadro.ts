// L4-T8 — a REDE DE SEGURANÇA do "quadro 100%".
//
// MEDIDO em 02/09/2026 no gitorch: 52 issues abertas, 44 no quadro, 8 fora.
// O anexo na hora da criação (desejo-no-github.ts, incidente, board-status.ts)
// é o PRIMEIRO elo — mas é best-effort, e best-effort às vezes falha (rede,
// board sem quadro resolvido naquele instante, corrida). Esta varredura é o
// SEGUNDO elo: periodicamente relê TODAS as issues abertas do repositório e
// pendura no quadro qualquer uma que ainda não esteja lá, não importa quem a
// criou (desejo, incidente, humano, bot, o próprio dono).
//
// Paginada com teto — nunca gira para sempre num repositório absurdo — e
// gated por autonomia: só roda em `sugerir`/`cuidar`. `so_olhar` nem tenta LER
// a lista de issues, e não é a guarda de escrita (guarda-de-autonomia.ts) que
// segura isto — é ANTES dela, de propósito: assim um projeto em "só olhar"
// nunca aparece tentando e nunca conta "falha" por causa da recusa.

import { podeEscrever } from '@gitorch/cadence'
import type { GqlDoGithub } from './anexar-ao-quadro.js'
import { nomeDeRepositorioValido } from './nome-de-repositorio.js'

export interface NoDeIssueAberta {
  id: string
  number: number
  projectItems?: { nodes?: Array<{ project?: { id?: string } }> }
}

export interface ConexaoDeIssuesAbertas {
  nodes?: NoDeIssueAberta[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
}

export interface PaginaDeIssuesAbertas {
  repository?: {
    issues?: ConexaoDeIssuesAbertas
  }
}

export interface DepsDaVarreduraDeQuadro {
  /** "dono/nome" — usado para montar a consulta e para todo log. */
  repositorio: string
  /** Node id do quadro (Projects v2) JÁ resolvido — esta varredura não escolhe quadro. */
  projectId: string
  /** Nível de autonomia REAL do projeto — escrita só roda em sugerir/cuidar. */
  nivelDeAutonomia: string | null | undefined
  gql: GqlDoGithub
  /** Pendura UMA issue no quadro (tipicamente `anexarAoQuadro` por baixo). */
  anexarAoQuadro: (issueNodeId: string) => Promise<unknown>
  /** Teto de páginas desta passada — nunca sem limite (mil issues = 10 páginas de 100). */
  tetoDePaginas?: number
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

export interface ResultadoDaVarreduraDeQuadro {
  repo: string
  abertas: number
  fora: number
  anexadas: number
  falhas: number
}

/** 10 páginas de 100 = mil issues abertas por repositório — teto generoso. */
export const TETO_DE_PAGINAS_DA_VARREDURA = 10
const ITENS_POR_PAGINA = 100

// Achado G (revisão do fix-up 2) — o `first: 20` de `projectItems` abaixo,
// DELIBERADAMENTE mantido (diferente do `first: 100` de anexar-ao-quadro.ts):
// aqui a pergunta é só "esta issue já está NO NOSSO quadro?" (um só,
// `deps.projectId`), nunca "reencontrar o item entre muitos". Uma issue
// pendurada em 21+ quadros pode ser tratada como "fora" por engano — o nosso
// não aparecer nos primeiros 20 — e ganhar uma tentativa de anexo a mais;
// best-effort e idempotente (`anexarAoQuadro` já sabe lidar com "já existe"),
// sem risco real, só uma chamada extra ocasional.
const QUERY_ISSUES_ABERTAS = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: ${ITENS_POR_PAGINA}, after: $after) {
        nodes {
          id
          number
          projectItems(first: 20) { nodes { project { id } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

/**
 * Varre as issues abertas de UM repositório e pendura no quadro as que ainda
 * não estão lá.
 *
 * Nunca lança: um repositório que falhar no meio (rede, GitHub fora do ar)
 * devolve o que já contou até ali — quem chama decide se tenta de novo no
 * próximo tique. Uma issue que falha ao anexar NÃO para as outras da mesma
 * passada; a falha vira `onWarn` e conta em `falhas`.
 */
export async function varrerIssuesForaDoQuadro(
  deps: DepsDaVarreduraDeQuadro
): Promise<ResultadoDaVarreduraDeQuadro> {
  const info = deps.onInfo ?? ((): void => undefined)
  const warn = deps.onWarn ?? ((): void => undefined)
  const resultado: ResultadoDaVarreduraDeQuadro = {
    repo: deps.repositorio,
    abertas: 0,
    fora: 0,
    anexadas: 0,
    falhas: 0,
  }

  // Achado C (revisão do fix-up 2): a lista própria `NIVEIS_QUE_ESCREVEM`
  // duplicava a tabela de `packages/cadence/src/autonomia.ts` — a mesma
  // lição do SSRF, regra de autonomia espalhada diverge da central sem
  // ninguém perceber. `podeEscrever` cobre nível nulo/desconhecido pelo
  // mesmo fail-closed (`normalizarNivel`), então o comportamento não muda.
  if (!podeEscrever(deps.nivelDeAutonomia, 'organizar').pode) {
    info(`[Scheduler] quadro ${deps.repositorio}: autonomia "só olhar" — varredura não escreve.`)
    return resultado
  }

  // Achado B (revisão do fix-up 2): `deps.repositorio` vai colado numa URL
  // que carrega credencial (dentro de `gql`, por quem monta a chamada real)
  // — a mesma porta que `desejo-no-github.ts` já guarda. Recusar ANTES do
  // `.split('/')` fecha para um valor que atravesse diretório ou troque de
  // host; nunca toca a rede, e conta como falha (nunca como "0 fora" — a
  // varredura NÃO rodou, não é "rodou e não achou nada").
  if (!nomeDeRepositorioValido(deps.repositorio)) {
    resultado.falhas += 1
    warn(
      `[Scheduler] quadro ${deps.repositorio}: repositório fora do formato dono/repositorio — varredura recusada antes de tocar a rede`
    )
    return resultado
  }

  const [owner, name] = deps.repositorio.split('/')
  const teto = deps.tetoDePaginas ?? TETO_DE_PAGINAS_DA_VARREDURA

  let after: string | null = null
  for (let pagina = 0; pagina < teto; pagina++) {
    let data: PaginaDeIssuesAbertas
    try {
      data = await deps.gql<PaginaDeIssuesAbertas>(QUERY_ISSUES_ABERTAS, { owner, name, after })
    } catch (err) {
      // Achado B — `gql` pode lançar (rede, ou `GithubExecutionError` de
      // `criarGqlDoGithub` quando a resposta vem com `errors[]`). Sem este
      // catch, UM repositório instável derrubava a função inteira — contra
      // o próprio contrato documentado acima ("nunca lança").
      resultado.falhas += 1
      warn(
        `[Scheduler] quadro ${deps.repositorio}: falha ao ler issues abertas (${String(err).slice(0, 160)})`
      )
      break
    }
    const conexao: ConexaoDeIssuesAbertas | undefined = data.repository?.issues
    if (!conexao) {
      // Achado B — antes desta correção, isto era um `break` silencioso:
      // o `info` de resumo lá embaixo dizia "0 fora, 0 anexadas, 0 falhas",
      // indistinguível de um repositório limpo de verdade. Um `data`
      // sem `repository`/`issues` é sempre anomalia (repo renomeado,
      // apagado, permissão perdida no meio do caminho) — nunca "nada a
      // fazer".
      resultado.falhas += 1
      warn(
        `[Scheduler] quadro ${deps.repositorio}: resposta do GitHub sem repository/issues — varredura incompleta`
      )
      break
    }

    for (const issue of conexao.nodes ?? []) {
      resultado.abertas += 1
      const jaNoQuadro = (issue.projectItems?.nodes ?? []).some(
        (n: { project?: { id?: string } }) => n.project?.id === deps.projectId
      )
      if (jaNoQuadro) continue

      resultado.fora += 1
      try {
        await deps.anexarAoQuadro(issue.id)
        resultado.anexadas += 1
      } catch (err) {
        resultado.falhas += 1
        warn(
          `[Scheduler] quadro ${deps.repositorio}: falha ao anexar issue #${issue.number} (${String(err).slice(0, 120)})`
        )
      }
    }

    if (!conexao.pageInfo?.hasNextPage) break
    after = conexao.pageInfo.endCursor ?? null
  }

  info(
    `[Scheduler] quadro ${deps.repositorio}: ${resultado.fora} fora, ${resultado.anexadas} anexadas, ${resultado.falhas} falhas`
  )
  return resultado
}
