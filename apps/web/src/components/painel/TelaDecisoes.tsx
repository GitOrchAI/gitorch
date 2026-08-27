'use client'
// Decisões: quando um agente precisa de uma escolha sua, ele para e pergunta
// aqui. Responder destrava o trabalho na hora — a mesma pergunta chega no
// Telegram. Portado de TelaDecisoes.jsx. Dados AO VIVO (fetchAgentQuestions,
// reusado); responder AO VIVO (POST /painel/decisoes/:id/responder).
import { useState } from 'react'
import { Ad } from './PainelIcons'
import { Card, Chips, Cabeca, Decisao, type DecisaoView } from './PainelUI'

export function TelaDecisoes({
  decisoes,
  responder,
  aviso,
  foco,
  setFoco,
}: {
  decisoes: DecisaoView[]
  responder: (id: string, resposta: string) => void
  /** frase de erro do último envio (ex.: 409 já respondida pelo Telegram) */
  aviso: string | null
  foco: string | null
  setFoco: (id: string) => void
}) {
  const [filtro, setFiltro] = useState<'pendente' | 'respondida' | 'todas'>('pendente')
  const lista = decisoes.filter((d) => filtro === 'todas' || d.st === filtro)
  const sel = decisoes.find((d) => d.id === foco) ?? lista[0]
  const pend = decisoes.filter((d) => d.st === 'pendente').length

  return (
    <>
      <Cabeca titulo="Decisões">
        Quando um agente precisa de uma escolha sua, ele para e pergunta aqui. Responder destrava o
        trabalho na hora — e a mesma pergunta também chega no seu Telegram.
      </Cabeca>

      {aviso && (
        <div className="ad-pulse cold">
          <Ad n="alert" s={16} />
          <span>{aviso}</span>
        </div>
      )}

      <Chips
        valor={filtro}
        onChange={setFiltro}
        opcoes={[
          ['pendente', 'Esperando você' + (pend ? ' · ' + pend : '')],
          ['respondida', 'Respondidas'],
          ['todas', 'Todas'],
        ]}
      />

      <div className="ad-md">
        <Card flush>
          {lista.length === 0 ? (
            <div className="ad-empty">
              {filtro === 'pendente' ? 'Nada esperando por você agora.' : 'Nada por aqui.'}
            </div>
          ) : (
            lista.map((d) => (
              <button
                key={d.id}
                className={'ad-row' + (sel && sel.id === d.id ? ' on' : '')}
                style={{ alignItems: 'flex-start' }}
                onClick={() => setFoco(d.id)}
              >
                <span className="ad-grow">
                  <span
                    className="ad-rt"
                    style={{
                      display: 'block',
                      whiteSpace: 'normal',
                      color: d.st === 'pendente' ? 'var(--gl-ink)' : 'var(--gl-muted)',
                    }}
                  >
                    {d.q}
                  </span>
                  <span className="ad-rs">
                    {d.agente} · {d.quando}
                  </span>
                </span>
                {d.st === 'pendente' ? (
                  <span className="ad-d wait" style={{ marginTop: 6 }} />
                ) : (
                  <span style={{ color: 'var(--gl-accent-ink)', flex: 'none', marginTop: 2 }}>
                    <Ad n="check" s={15} />
                  </span>
                )}
              </button>
            ))
          )}
        </Card>

        <Card flush>
          {!sel ? (
            <div className="ad-empty">Escolha uma decisão.</div>
          ) : (
            <Decisao d={sel} responder={responder} />
          )}
        </Card>
      </div>
    </>
  )
}
