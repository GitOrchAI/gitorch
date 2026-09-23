'use client'
// Repositório: cada ficha (pedido, tarefa, alerta) com origem e próximo
// passo — mesmo contrato de dados vivos das outras telas (usePainelBusca).

import { Cabeca, Card } from './PainelUI'
import { Estados } from './PainelEstados'
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
  const dados = usePainelBusca<RepositorioPayload>(ROTAS.repositorio, {
    vazio: (d) => d.itens.length === 0,
  })

  return (
    <>
      <Cabeca titulo="Repositório">
        Cada pedido, tarefa e alerta, com origem e próximo passo.
      </Cabeca>
      <Card flush titulo="Itens">
        <Estados r={dados} o_que="o repositório" vazio="Nada por aqui ainda.">
          {(payload) =>
            payload.itens.map((item) => (
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
            ))
          }
        </Estados>
      </Card>
    </>
  )
}
