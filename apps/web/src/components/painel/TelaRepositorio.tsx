'use client'
// Repositório: cada ficha (pedido, tarefa, alerta) com origem e próximo
// passo — mesmo contrato de dados vivos das outras telas (usePainelBusca).

import { Cabeca, Card } from './PainelUI'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'

interface ItemDoRepositorio {
  tipo: string
  numero: number
  origem: string | null
  proximoPasso: string | null
}

interface RepositorioPayload {
  itens: ItemDoRepositorio[]
}

export function TelaRepositorio() {
  const dados = usePainelBusca<RepositorioPayload>(ROTAS.repositorio)

  return (
    <>
      <Cabeca titulo="Repositório">
        Cada pedido, tarefa e alerta, com origem e próximo passo.
      </Cabeca>
      <Card flush titulo="Itens">
        {dados.estado === 'ok' &&
          dados.dados?.itens.map((item) => (
            <div key={`${item.tipo}-${item.numero}`} className="pn-row static">
              <span className="pn-grow">
                <span className="pn-rt">
                  {item.tipo === 'pr'
                    ? 'Pull request'
                    : item.tipo === 'issue'
                      ? 'Tarefa'
                      : 'Alerta'}{' '}
                  #{item.numero}
                </span>
                <span className="pn-rs">
                  {item.origem ?? 'origem ainda não classificada'} —{' '}
                  {item.proximoPasso ?? 'sem decisão registrada ainda'}
                </span>
              </span>
            </div>
          ))}
        {dados.estado === 'ok' && dados.dados?.itens.length === 0 && (
          <p style={{ margin: 18, fontSize: 13.5, color: 'var(--gl-muted)' }}>
            Nada por aqui ainda.
          </p>
        )}
      </Card>
    </>
  )
}
