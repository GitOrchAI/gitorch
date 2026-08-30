'use client'
// Entregas: o que ficou PRONTO, e o que ainda não — com o motivo escrito.
//
// AO VIVO desde a leva 2, bloco 5. Antes esta tela mostrava exemplo com selo,
// porque a rota não existia; agora ela lê /api/v1/painel/entregas.
//
// Scrum 2020: o Incremento nasce quando um item atende à Definição de Pronto.
// A régua é do CLIENTE (Configurações), e o que falta vem escrito — uma
// entrega parada sem ninguém dizer por quê é o silêncio que este bloco veio
// acabar.
import { useSyncExternalStore } from 'react'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Estado } from './PainelUI'
import { Estados } from './PainelEstados'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'

interface EntregaView {
  projeto: string
  pedido: number
  entrega: number | null
  pronto: boolean
  prontoEm: string | null
  atendidos: string[]
  porQueNaoFechou: string[]
}

/** Data curta, do jeito que o dono lê. */
function quando(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function TelaEntregas() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<
    { entregas: EntregaView[]; prontas: number },
    { entregas?: EntregaView[]; prontas?: number }
  >(ROTAS.entregas + filtroDeProjeto(projeto), {
    mapear: (b) => ({ entregas: b.entregas ?? [], prontas: b.prontas ?? 0 }),
    vazio: (d) => d.entregas.length === 0,
  })

  return (
    <>
      <Cabeca titulo="Entregas">
        O que ficou pronto pela sua régua — e, no que ainda não fechou, o que está faltando.
      </Cabeca>

      <Estados
        r={r}
        o_que="as suas entregas"
        vazio="Nenhuma entrega ainda. A primeira aparece aqui assim que sair."
      >
        {(d) => (
          <>
            <Card>
              <span className="pn-label">Prontas</span>
              <div className="num" style={{ fontSize: 26, fontWeight: 600 }}>
                {d.prontas}
              </div>
              <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 2 }}>
                de {d.entregas.length} que passaram pela régua
              </div>
            </Card>

            <div className="pn-3" style={{ marginTop: 16 }}>
              {d.entregas.map((e) => (
                <Card key={`${e.projeto}-${e.pedido}`}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.025em' }}>
                        Pedido #{e.pedido}
                        {e.entrega !== null && (
                          <span style={{ color: 'var(--gl-faint)', fontWeight: 400 }}>
                            {' '}
                            · entrega #{e.entrega}
                          </span>
                        )}
                      </div>
                      <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 4 }}>
                        {e.projeto}
                      </div>
                    </div>
                    {e.pronto ? (
                      <Estado d="go">Pronto{e.prontoEm ? ` · ${quando(e.prontoEm)}` : ''}</Estado>
                    ) : (
                      <Estado d="idle">Ainda não</Estado>
                    )}
                  </div>

                  {/* O que falta é a parte que não pode se perder. Uma entrega
                      parada sem motivo escrito é o silêncio que esta tela veio
                      acabar. */}
                  {!e.pronto && e.porQueNaoFechou.length > 0 && (
                    <ul
                      style={{
                        margin: '14px 0 0',
                        paddingLeft: 18,
                        fontSize: 13.5,
                        color: 'var(--gl-muted)',
                      }}
                    >
                      {e.porQueNaoFechou.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}

                  {e.pronto && e.atendidos.length > 0 && (
                    <div
                      style={{
                        marginTop: 14,
                        fontSize: 13,
                        color: 'var(--gl-muted)',
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      {e.atendidos.map((a) => (
                        <span key={a}>· {a}</span>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}
      </Estados>
    </>
  )
}
