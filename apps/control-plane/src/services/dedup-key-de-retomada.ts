/**
 * Fonte ÚNICA de `retomada-travada:<repo>:<pr>` — o dedupKey da pergunta ao
 * dono quando um pull request reprovado bate o teto de retomadas
 * (`retomarPrReprovado`, retomar-pr-reprovado.ts).
 *
 * C1 (fix-up L4-T5, CSO): a versão anterior montava a chave inline em
 * `plugins/scheduler.ts` como `retomada-travada:<repo>:<pr>:<retomadasAnteriores>`
 * — incluindo o PRÓPRIO contador que a decisão observa. Como
 * `AgentQuestionService.ask` dedupa por `{projectId, dedupKey, status:
 * 'answered'}`, uma chave que muda a cada ciclo nunca bate de novo: a
 * resposta do dono a "retomado 3× — o que fazer?" ficava órfã assim que o
 * contador mudasse, e a próxima escalada do MESMO PR perguntava de novo do
 * zero. A chave certa é estável POR PULL REQUEST — mesmo padrão de
 * `dedup-key-de-duvida.ts` (`duvida-dev:<repo>:<issue>:<hash>`): o que
 * identifica a pergunta é o QUE está travado (este PR), não o estado
 * momentâneo de quantas vezes já tentou.
 */

const PREFIXO_RETOMADA_TRAVADA = 'retomada-travada:'

export interface RetomadaTravadaDedupKey {
  repository: string
  prNumber: number
}

function repoParecUmRepositorioDoGithub(repo: string): boolean {
  return repo.includes('/')
}

/**
 * Monta `retomada-travada:<repo>:<pr>`. VALIDA e lança em vez de montar uma
 * chave quebrada em silêncio — mesma disciplina de `dedupKeyDeDuvidaDoDev`:
 * `repo` sempre carrega `/` (nome de repositório do GitHub é sempre
 * `dono/nome`), e `prNumber` é inteiro positivo.
 */
export function dedupKeyDeRetomada(args: { repo: string; prNumber: number }): string {
  if (!args.repo || !repoParecUmRepositorioDoGithub(args.repo)) {
    throw new Error(
      `dedupKeyDeRetomada: repo '${args.repo}' não parece um repositório do GitHub (esperado 'dono/nome')`
    )
  }
  if (!Number.isInteger(args.prNumber) || args.prNumber <= 0) {
    throw new Error(
      `dedupKeyDeRetomada: prNumber inválido (${args.prNumber}) — precisa ser inteiro positivo`
    )
  }
  return `${PREFIXO_RETOMADA_TRAVADA}${args.repo}:${args.prNumber}`
}

/**
 * Lê `retomada-travada:<repo>:<pr>` de volta. Formato desconhecido/mal
 * formado (inclusive o formato ANTIGO, com um terceiro campo de
 * `retomadasAnteriores`) devolve `null` DE PROPÓSITO, nunca lança — o mesmo
 * contrato de `parseDedupKeyDeDuvidaDoDev`: quem chama só age para dedupKey
 * deste formato exato.
 */
export function parseDedupKeyDeRetomada(dedupKey: string): RetomadaTravadaDedupKey | null {
  if (!dedupKey.startsWith(PREFIXO_RETOMADA_TRAVADA)) return null
  const resto = dedupKey.slice(PREFIXO_RETOMADA_TRAVADA.length)
  const partes = resto.split(':')
  if (partes.length !== 2) return null
  const [repository, prNumberBruto] = partes
  const prNumber = Number(prNumberBruto)
  if (
    !repository ||
    !repoParecUmRepositorioDoGithub(repository) ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0
  ) {
    return null
  }
  return { repository, prNumber }
}
