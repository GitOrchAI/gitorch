'use client'
// Entregas: o histórico do que entrou em produção, escrito pelo GANHO que
// trouxe — não pelo código. /painel/entregas é leva 2; nesta leva a tela
// mostra o exemplo com selo (some sozinho quando a rota existir). Portado de
// TelaEntregas.jsx.
import { DEMO } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Tecnico } from './PainelUI'
import { Estados } from './PainelEstados'

interface EntregaItemView {
  t: string
  repo: string
  quando: string
  ganho?: string
  resp: string
  tec: string
}
interface GrupoView {
  semana: string
  total: number
  itens: EntregaItemView[]
}

export function TelaEntregas() {
  const r = usePainelBusca<{ grupos: GrupoView[] }>(ROTAS.entregas, {
    demo: { grupos: DEMO.entregas.map((g) => ({ ...g, itens: [...g.itens] })) },
    exemploQuandoAusente: true,
    vazio: (d) => !d.grupos || d.grupos.length === 0,
  })

  return (
    <>
      <Cabeca titulo="Entregas">
        O histórico do que entrou em produção, escrito pelo ganho que trouxe — não pelo código que
        mudou.
      </Cabeca>

      <Estados
        r={r}
        o_que="o histórico de entregas"
        vazio="Nenhuma entrega ainda. A primeira aparece aqui assim que sair."
      >
        {(d) =>
          d.grupos.map((g) => (
            <Card
              key={g.semana}
              flush
              titulo={g.semana}
              sub={`${g.total} entregas${r.demo ? ' · dado de exemplo' : ''}`}
            >
              {g.itens.map((i) => (
                <div
                  key={i.t}
                  className="pn-row static"
                  style={{
                    alignItems: 'flex-start',
                    flexDirection: 'column',
                    gap: 0,
                    padding: '16px 18px',
                  }}
                >
                  <div
                    style={{ display: 'flex', gap: 12, width: '100%', alignItems: 'flex-start' }}
                  >
                    <span className="pn-d done" style={{ marginTop: 7 }} />
                    <span className="pn-grow">
                      <span
                        className="pn-rt"
                        style={{ display: 'block', whiteSpace: 'normal', fontSize: 14.5 }}
                      >
                        {i.t}
                      </span>
                      {i.ganho ? (
                        <span
                          style={{
                            display: 'block',
                            fontSize: 13,
                            color: 'var(--gl-muted)',
                            marginTop: 5,
                            lineHeight: 1.5,
                          }}
                        >
                          {i.ganho}
                        </span>
                      ) : null}
                      <span className="pn-rs">
                        {i.repo} · {i.quando} · {i.resp}
                      </span>
                    </span>
                  </div>
                  <div style={{ paddingLeft: 19 }}>
                    <Tecnico>{i.tec}</Tecnico>
                  </div>
                </div>
              ))}
            </Card>
          ))
        }
      </Estados>
    </>
  )
}
