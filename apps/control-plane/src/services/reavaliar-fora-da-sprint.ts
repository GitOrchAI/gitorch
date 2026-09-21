import { analisarCustoDaOrdem, type PedidoNaFila } from '@gitorch/cadence'

export function reavaliarForaDaSprint(deps: { pedido: PedidoNaFila; fila: PedidoNaFila[] }): {
  entraAgora: boolean
  motivo: string
} {
  const analise = analisarCustoDaOrdem([...deps.fila, deps.pedido])
  if (!analise.custaCaro) {
    return { entraAgora: false, motivo: 'custo de espera baixo — entra na ordem normal da fila' }
  }
  return {
    entraAgora: false,
    motivo: `custo de espera relevante (candidato #${analise.candidato.pedido}, perda ${analise.candidato.perda}, razão ${analise.candidato.razao.toFixed(2)}) — pergunte ao dono antes de decidir`,
  }
}
