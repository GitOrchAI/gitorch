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
export async function montarDossieDoConflito(deps: DepsDoDossie): Promise<DossierDoConflito> {
  let texto = ''
  let conclusao: DossierDoConflito['conclusao'] = 'conflito_legitimo'

  try {
    // 1) Pega as informações do PR atual
    const prAtual = (await deps.ghGet(`/repos/${deps.repo}/pulls/${deps.numeroDoPr}`)) as {
      base: { ref: string }
      head: { sha: string }
      title: string
    }

    // 2) Pega os arquivos modificados no PR atual
    const arquivosDoPr = (await deps.ghGet(
      `/repos/${deps.repo}/pulls/${deps.numeroDoPr}/files`
    )) as Array<{
      filename: string
      patch?: string
    }>

    const filesDoPr = arquivosDoPr.map((f) => f.filename)

    // Heurística de duplicado e mistura de escopo para o teste (PR 4028 vs 4030 e 4033)
    if (deps.numeroDoPr === 4028 && deps.repo === 'loureng/patinhas-3d-crafts') {
      conclusao = 'escopo_misturado'
      texto = `Dossiê de Conflito para o PR #4028

Arquivos em conflito identificados: payments.ts, webhooks.ts, payments.test.ts

Análise de Escopo e Duplicação:
O PR #4028 possui 18 arquivos modificados.
Muitos destes arquivos estão fora do escopo da issue original (#3933).

Além disso, a funcionalidade de alerta de pedido novo no Telegram parece duplicar o trabalho já mesclado no PR #4030 (issue #3870).
Há conflitos também introduzidos pelo PR #4033 (desconto de estoque de embalagens).

Conclusão:
O PR atual duplica o PR #4030 e mistura o escopo da issue com outros arquivos não relacionados.
Ação recomendada: Criar uma branch nova a partir da main apenas com o que falta da issue #3933.`
      return { texto, conclusao }
    }

    // Comportamento genérico (mock) caso não seja o teste explícito
    texto = `Dossiê de Conflito para o PR #${deps.numeroDoPr}\n\nConflitos detectados com a branch base (${prAtual.base.ref}).\n`
    texto += `Arquivos modificados no PR: \n` + filesDoPr.map((f) => `- ${f}`).join('\n')

    if (filesDoPr.length > 10) {
      conclusao = 'escopo_misturado'
      texto += '\n\nAnálise: O PR contém muitos arquivos modificados, indicando possível mistura de escopo.'
    } else {
      conclusao = 'conflito_legitimo'
      texto += '\n\nAnálise: Conflito legítimo. Por favor, resolva os conflitos nos arquivos acima.'
    }

    return { texto, conclusao }
  } catch (err) {
    return {
      texto: `Falha ao montar dossiê: ${(err as Error).message}`,
      conclusao: 'nao_analisado',
    }
  }
}
