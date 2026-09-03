/**
 * Fonte ÚNICA de `duvida-dev:<repo>:<issue>:<hash>` — o dedupKey que liga uma
 * dúvida escalada do dev assíncrono (`agent_question`) à sessão que ficou
 * esperando (`retomar-sessao-com-resposta.ts`).
 *
 * A2 (fix-up L4-T3): antes desta extração o formato era montado a mão em
 * `escalar-duvida-ao-dono.ts` E em `reconciliar-duvidas-escaladas.ts`, e
 * parseado a mão em `retomar-sessao-com-resposta.ts` — três cópias do mesmo
 * template literal. Divergir uma delas (ex.: trocar a ordem de `repo`/
 * `issue`, ou esquecer um `:`) não dá erro de tipo — só faz a resposta do
 * dono nunca achar a sessão de volta, um defeito que só aparece em produção.
 * Uma fonte só elimina essa classe de erro.
 */

const PREFIXO_DUVIDA_DEV = 'duvida-dev:'

export interface DuvidaDevDedupKey {
  repository: string
  issueNumber: number
  hash: string
}

function repoParecUmRepositorioDoGithub(repo: string): boolean {
  return repo.includes('/')
}

/**
 * Monta `duvida-dev:<repo>:<issue>:<hash>`. VALIDA e lança em vez de montar
 * uma chave quebrada silenciosamente: `repo` sempre carrega `/` (nomes de
 * repositório do GitHub são sempre `dono/nome`), `issue` é inteiro positivo,
 * e `hash` nunca contém `:` (é o próprio separador do formato — um hash com
 * `:` corromperia o parse de volta).
 */
export function dedupKeyDeDuvidaDoDev(args: { repo: string; issue: number; hash: string }): string {
  if (!args.repo || !repoParecUmRepositorioDoGithub(args.repo)) {
    throw new Error(
      `dedupKeyDeDuvidaDoDev: repo '${args.repo}' não parece um repositório do GitHub (esperado 'dono/nome')`
    )
  }
  if (!Number.isInteger(args.issue) || args.issue <= 0) {
    throw new Error(
      `dedupKeyDeDuvidaDoDev: issue inválida (${args.issue}) — precisa ser inteiro positivo`
    )
  }
  if (!args.hash || args.hash.includes(':')) {
    throw new Error(
      `dedupKeyDeDuvidaDoDev: hash inválido ('${args.hash}') — não pode ser vazio nem conter ':'`
    )
  }
  return `${PREFIXO_DUVIDA_DEV}${args.repo}:${args.issue}:${args.hash}`
}

/**
 * Lê `duvida-dev:<repo>:<issue>:<hash>` de volta. Formato desconhecido/mal
 * formado devolve `null` DE PROPÓSITO (nunca lança): quem chama
 * (`agent-question.ts answer()`, via os manipuladores por prefixo) só aciona
 * a retomada para dedupKey deste tipo — o mesmo contrato de `automacao:*`.
 */
export function parseDedupKeyDeDuvidaDoDev(dedupKey: string): DuvidaDevDedupKey | null {
  if (!dedupKey.startsWith(PREFIXO_DUVIDA_DEV)) return null
  const resto = dedupKey.slice(PREFIXO_DUVIDA_DEV.length)
  const partes = resto.split(':')
  if (partes.length !== 3) return null
  const [repository, issueNumberBruto, hash] = partes
  const issueNumber = Number(issueNumberBruto)
  if (
    !repository ||
    !repoParecUmRepositorioDoGithub(repository) ||
    !hash ||
    !Number.isInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return null
  }
  return { repository, issueNumber, hash }
}
