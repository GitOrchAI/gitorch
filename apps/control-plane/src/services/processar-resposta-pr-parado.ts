import { parseDedupKeyDeCuidaDestePedido } from './perguntar-se-cuida.js'
import type { ResultadoDoManipuladorDeResposta } from './agent-question.js'

export interface DepsProcessarRespostaPrParado {
  /** Ação quando o dono decide mesclar o PR agora */
  mesclar: (repo: string, numero: number) => Promise<void>
  /** Ação quando o dono decide pedir ajustes (abrir sessão de conserto) */
  pedirAjuste: (repo: string, numero: number) => Promise<void>
  /** Ação quando o dono decide fechar o PR */
  fecharPr: (repo: string, numero: number) => Promise<void>
  /** Registra a decisão no painel da timeline, útil para opções abertas (texto livre) */
  registrarNoPainel: (repo: string, numero: number, texto: string) => Promise<void>
}

export async function processarRespostaPrParado(
  args: { dedupKey: string; resposta: string },
  deps: DepsProcessarRespostaPrParado
): Promise<ResultadoDoManipuladorDeResposta | void> {
  const parsed = parseDedupKeyDeCuidaDestePedido(args.dedupKey)
  if (!parsed) return // Não é desta responsabilidade

  const { repository, numeroDoPr } = parsed

  if (args.resposta === 'pr-parado-mesclar') {
    await deps.mesclar(repository, numeroDoPr)
    await deps.registrarNoPainel(repository, numeroDoPr, `GitOrch: você mandou mesclar agora.`)
    return
  }

  if (args.resposta === 'pr-parado-pedir-ajuste') {
    await deps.pedirAjuste(repository, numeroDoPr)
    await deps.registrarNoPainel(
      repository,
      numeroDoPr,
      `GitOrch: você pediu ajuste (sessão aberta).`
    )
    return
  }

  if (args.resposta === 'pr-parado-fechar') {
    await deps.fecharPr(repository, numeroDoPr)
    await deps.registrarNoPainel(
      repository,
      numeroDoPr,
      `GitOrch: você mandou fechar o pull request.`
    )
    return
  }

  // Texto livre, só registramos no painel para auditoria.
  await deps.registrarNoPainel(
    repository,
    numeroDoPr,
    `GitOrch (pergunta sobre PR): ${args.resposta}`
  )
  return
}
