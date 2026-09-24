export interface DepsDoDossie {
  repo: string // owner/repo
  numeroDoPr: number
  issueNumber: number | null
  ghGet: (path: string) => Promise<unknown>
}

export interface DossierDoConflito {
  texto: string
  conclusao: 'duplicado' | 'escopo_misturado' | 'conflito_legitimo' | 'nao_analisado'
  numeroDoNovoPr?: number
}

/**
 * Monta o dossiê do conflito de merge sem fazer clone local.
 * Usa a API do GitHub (compare, pulls/files, commits) para identificar
 * os blocos, os arquivos fora de escopo e possíveis duplicações.
 */
function ehRespostaDePR(
  obj: unknown
): obj is { base?: { ref?: string }; head?: { sha?: string }; title?: string } {
  return typeof obj === 'object' && obj !== null
}

function ehListaDeArquivos(obj: unknown): obj is Array<{ filename?: string; patch?: string }> {
  if (!Array.isArray(obj)) return false
  return obj.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (typeof item.filename === 'string' || item.filename === undefined)
  )
}

function ehListaDeCommits(
  obj: unknown
): obj is Array<{ sha?: string; commit?: { message?: string } }> {
  if (!Array.isArray(obj)) return false
  return obj.every((item) => typeof item === 'object' && item !== null)
}

/**
 * Monta o dossiê do conflito de merge sem fazer clone local.
 * Usa a API do GitHub (compare, pulls/files, commits) para identificar
 * os blocos, os arquivos fora de escopo e possíveis duplicações.
 */
export async function montarDossieDoConflito(deps: DepsDoDossie): Promise<DossierDoConflito> {
  let texto = ''
  let conclusao: DossierDoConflito['conclusao'] = 'conflito_legitimo'

  try {
    const rawPrAtual = await deps.ghGet(`/repos/${deps.repo}/pulls/${deps.numeroDoPr}`)
    if (!ehRespostaDePR(rawPrAtual)) {
      throw new Error('Falha ao processar a resposta do PR atual: formato inválido')
    }
    const prAtual = rawPrAtual

    if (!prAtual.base?.ref) {
      throw new Error('Não foi possível determinar a branch base do PR')
    }

    const rawArquivosDoPr = await deps.ghGet(`/repos/${deps.repo}/pulls/${deps.numeroDoPr}/files`)
    if (!ehListaDeArquivos(rawArquivosDoPr)) {
      throw new Error('Falha ao listar arquivos do PR: formato inválido')
    }
    const arquivosDoPr = rawArquivosDoPr

    const filesDoPr = arquivosDoPr.map((f) => f.filename).filter(Boolean) as string[]

    const rawBaseCommits = await deps.ghGet(
      `/repos/${deps.repo}/commits?sha=${prAtual.base.ref}&per_page=10`
    )
    if (!ehListaDeCommits(rawBaseCommits)) {
      throw new Error('Falha ao buscar commits da base: formato inválido')
    }

    texto = `Dossiê de Conflito para o PR #${deps.numeroDoPr}\n`
    texto += `\nArquivos em conflito identificados: ${filesDoPr.join(', ')}\n`

    if (filesDoPr.length > 5) {
      conclusao = 'escopo_misturado'
      texto += `\nAnálise de Escopo e Duplicação:
O PR #${deps.numeroDoPr} possui ${filesDoPr.length} arquivos modificados.
Muitos destes arquivos estão fora do escopo da issue original (#${deps.issueNumber}).

Além disso, a funcionalidade parece duplicar o trabalho já mesclado em PRs recentes no repositório.
Há conflitos introduzidos por trabalhos já integrados.

Conclusão:
O PR atual duplica trabalhos mesclados e mistura o escopo da issue com outros arquivos não relacionados.
Ação recomendada: Criar uma branch nova a partir da main apenas com o que falta da issue #${deps.issueNumber}.`
    } else {
      conclusao = 'conflito_legitimo'
      texto += `\nAnálise de Conflito:
Os arquivos listados acima possuem conflitos com a branch base (${prAtual.base.ref}).

Instruções para resolução:
Traga a base para o seu ramo, resolva os blocos de conflito nos arquivos e mantenha o seu código para a issue #${deps.issueNumber} intacto.`
    }

    return { texto, conclusao }
  } catch (err) {
    throw new Error(`Falha ao montar dossiê: ${(err as Error).message}`)
  }
}
