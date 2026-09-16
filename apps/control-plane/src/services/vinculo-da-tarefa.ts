// Acha a tarefa de origem de um pull request pela pista mais forte
// disponível, nesta ordem: vínculo FORMAL do GitHub (closingIssuesReferences)
// → texto do corpo + sessão (ehPrDelegado, já existente) → branch do Jules
// (casarPrComSessao, já existente). Cada camada é mais fraca que a anterior;
// a primeira que achar vence — nunca combina pistas de camadas diferentes.

import { ehPrDelegado } from './pr-delegado.js'
import { casarPrComSessao, type SessaoParaCasamento } from './casar-pr-com-sessao.js'
import type { LinhaDeSessao } from './dev-session-store.js'

export type OrigemDoVinculo = 'formal' | 'texto' | 'branch-do-jules'

export interface VinculoDaTarefa {
  issueNumber: number
  origemDoVinculo: OrigemDoVinculo
}

export interface AcharTarefaDeps {
  numeroDoPr: number
  autor: string | undefined
  corpo: string | undefined
  headRefName: string | undefined
  sessoes: LinhaDeSessao[]
  /** `ProjectV2Client.closingIssuesDoPr` — injetado para o módulo continuar
   *  testável sem rede. */
  closingIssues: () => Promise<number[]>
  issueComEtiquetaDeDelegacao: (issueNumber: number) => boolean
}

export async function acharTarefaDoItem(deps: AcharTarefaDeps): Promise<VinculoDaTarefa | null> {
  // 1) FORMAL — o que o próprio GitHub já resolveu e mostra na UI.
  const formais = await deps.closingIssues()
  if (formais.length > 0) {
    return { issueNumber: formais[0] as number, origemDoVinculo: 'formal' }
  }

  // 2) TEXTO + SESSÃO — ehPrDelegado já cobre login/linha/regex+etiqueta com
  // a trava contra citação solta (ver o comentário de pr-delegado.ts sobre o
  // PR #99).
  const porTexto = ehPrDelegado({
    numeroDoPr: deps.numeroDoPr,
    autor: deps.autor,
    corpo: deps.corpo,
    sessoes: deps.sessoes,
    issueComEtiquetaDeDelegacao: deps.issueComEtiquetaDeDelegacao,
  })
  if (porTexto.delegado && porTexto.issueNumber !== null) {
    return { issueNumber: porTexto.issueNumber, origemDoVinculo: 'texto' }
  }

  // 3) BRANCH DO JULES — o identificador de sessão no nome do ramo.
  const sessoesParaCasamento: SessaoParaCasamento[] = deps.sessoes.map((s) => ({
    sessionName: s.sessionName,
    pullRequestNumber: s.pullRequestNumber,
  }))
  const casamento = casarPrComSessao({
    headRefName: deps.headRefName,
    corpo: deps.corpo,
    numeroDoPr: deps.numeroDoPr,
    sessoes: sessoesParaCasamento,
  })
  if (casamento) {
    const sessao = deps.sessoes.find((s) => s.sessionName === casamento.sessionName)
    if (sessao) return { issueNumber: sessao.issueNumber, origemDoVinculo: 'branch-do-jules' }
  }

  return null
}
