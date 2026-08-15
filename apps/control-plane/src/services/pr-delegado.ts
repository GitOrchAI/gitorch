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

  // 3) Recuo: palavra de ligação no corpo + etiqueta na issue.
  const ligada = (args.corpo ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
  if (ligada) {
    const n = Number(ligada)
    if (args.issueComEtiquetaDeDelegacao(n)) return { delegado: true, issueNumber: n }
  }

  return { delegado: false, issueNumber: null }
}
