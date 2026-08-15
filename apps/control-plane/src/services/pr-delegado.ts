// "Este PR é trabalho delegado, e de qual tarefa?"
//
// Três formas, em ordem de autoridade. A primeira é a nova e é a que funciona:
// a linha guardada na delegação. As duas outras eram as únicas que existiam, e
// as duas falham contra o PR real do dev assíncrono — medido: 85 execuções
// seguidas do QA dizendo que não havia PR para julgar, com o PR aberto. O autor
// sai como a conta da instalação (sem "jules" no login) e o corpo nem sempre
// traz palavra de ligação.
//
// Elas ficam como recuo, não como substitutas: cobrem o PR que nasceu antes
// desta mudança e o dia em que o serviço externo mudar de comportamento.

import type { LinhaDeSessao } from './dev-session-store.js'

export interface ResultadoPrDelegado {
  delegado: boolean
  /** A tarefa de origem, quando dá para saber. */
  issueNumber: number | null
}

export function ehPrDelegado(args: {
  numeroDoPr: number
  autor: string | undefined
  corpo: string | undefined
  /** Linhas de sessão deste projeto (vivas e fechadas). */
  sessoes: LinhaDeSessao[]
  /** Consulta se a issue carrega a etiqueta de delegação. */
  issueComEtiquetaDeDelegacao: (issueNumber: number) => boolean
}): ResultadoPrDelegado {
  // 1) A linha guardada — autoritativa.
  const porLinha = args.sessoes.find((s) => s.pullRequestNumber === args.numeroDoPr)
  if (porLinha) return { delegado: true, issueNumber: porLinha.issueNumber }

  // 2) Recuo: login do autor.
  if ((args.autor ?? '').toLowerCase().includes('jules')) {
    return { delegado: true, issueNumber: null }
  }

  // 3) Recuo: palavra de ligação no corpo + etiqueta na issue + SESSÃO
  // registrada para aquela issue.
  //
  // A sessão é obrigatória aqui — não é reforço, é a correção do furo mais
  // perigoso medido em produção (15/08/2026). Caso real: abri o PR #99 (autor
  // `loureng`, humano) e, ao DESCREVER um defeito no corpo, citei "Fixes #74"
  // — não como intenção de fechar aquela issue, só como referência. A issue
  // #74 carregava a etiqueta de delegação, mas nunca foi delegada (sem linha
  // em `dev_sessions`). Sem este guard, texto no corpo + etiqueta na issue
  // eram suficientes para o QA julgar o PR #99 como entrega do dev assíncrono
  // ("QA judged PR #99: request_changes (CI pending)") — só não mesclou
  // porque a verificação ainda rodava. Com CI verde e aprovação, o produto
  // teria mesclado sozinho um PR humano. Qualquer PR que mencione a palavra
  // de ligação com o número de uma issue delegada casava, por citação,
  // documentação ou relatório — como aconteceu aqui. Se ninguém de fato
  // delegou aquela issue ao dev assíncrono (sem linha), nenhum PR pode ser
  // "entrega" dela, por mais que o texto diga.
  const ligada = (args.corpo ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
  if (ligada) {
    const n = Number(ligada)
    const houveSessaoParaEssaIssue = args.sessoes.some((s) => s.issueNumber === n)
    if (houveSessaoParaEssaIssue && args.issueComEtiquetaDeDelegacao(n)) {
      return { delegado: true, issueNumber: n }
    }
  }

  return { delegado: false, issueNumber: null }
}
