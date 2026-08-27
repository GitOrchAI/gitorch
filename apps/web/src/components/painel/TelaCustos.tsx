'use client'
// Custos e limites: você usa a sua própria assinatura de cada ferramenta. O
// que o painel controla é quanto de cada cota já foi gasto. A cota dos motores
// é AO VIVO (best-effort — sem store de consumo persistida a tela degrada com
// honestidade); os KPIs de topo, o esforço por projeto e o plano ficam de
// exemplo (leva 2). Portado de TelaCustos.jsx.
import { DEMO } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Kpi, Barra } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'
import type { MotorCota } from './painel-tipos'

export function TelaCustos() {
  const motores = usePainelBusca<MotorCota[], { motores?: MotorCota[] }>(ROTAS.agentes, {
    mapear: (b) => b.motores ?? [],
    vazio: (d) => d.length === 0,
  })

  return (
    <>
      <Cabeca titulo="Custos e limites">
        Você usa a sua própria assinatura de cada ferramenta. O que o painel controla é quanto de
        cada cota já foi gasto, para nenhum motor travar no meio de uma entrega.
      </Cabeca>

      <div className="ad-kpis">
        <Kpi
          l="Tarefas hoje"
          v={55}
          n={
            <>
              somando todos os motores <SeloDemo mostrar />
            </>
          }
        />
        <Kpi l="Motor mais perto do teto" v="95%" n="Antigravity · 38 de 40" tone="w" destaque />
        <Kpi l="Entregas no mês" v={16} n="média de 4 por semana" tone="g" />
        <Kpi l="Repositórios ativos" v={3} n="do teto de 5 do seu plano" />
      </div>

      <Card
        titulo="Cota de cada motor"
        sub={
          <>
            últimas 24 horas
            <SeloDemo mostrar={!!motores.demo} />
          </>
        }
      >
        <Estados
          r={motores}
          o_que="as cotas dos motores"
          vazio="Nenhum motor com cota conhecida ainda. Assim que um motor reportar consumo, aparece aqui."
        >
          {(d) => (
            <div className="ad-3">
              {d.map((m) =>
                m.limite == null ? (
                  <div key={m.nome}>
                    <div className="ad-brow">
                      <b>{m.nome}</b>
                      <span className="num">{m.usado}</span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--gl-faint)' }}>
                      sem teto informado por este motor
                    </div>
                  </div>
                ) : (
                  <Barra key={m.nome} usado={m.usado} limite={m.limite} nome={m.nome} />
                )
              )}
            </div>
          )}
        </Estados>
      </Card>

      <Card flush titulo="Onde o esforço foi este mês" sub={<SeloDemo mostrar />}>
        <div className="ad-tw">
          <table>
            <thead>
              <tr>
                <th>Projeto</th>
                <th>Tarefas</th>
                <th>Fatia do esforço</th>
                <th>Entregas</th>
              </tr>
            </thead>
            <tbody>
              {DEMO.custoPorRepo.map((r) => (
                <tr key={r.repo}>
                  <td>
                    <b>{r.repo}</b>
                  </td>
                  <td className="num ad-nowrap">{r.tarefas}</td>
                  <td style={{ minWidth: 200 }}>
                    <div className="ad-brow">
                      <span className="num">{r.pct}%</span>
                    </div>
                    <div className="ad-bar" style={{ marginTop: 4 }}>
                      <i style={{ width: r.pct + '%' }} />
                    </div>
                  </td>
                  <td className="num ad-nowrap">{r.entregas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card titulo="Seu plano" sub={<SeloDemo mostrar />}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 200 }}>
            <span className="ad-label">Plano atual</span>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.03em' }}>
              {DEMO.plano}
            </div>
            <div style={{ fontSize: 13, color: 'var(--gl-muted)', marginTop: 6 }}>
              R$ 249 por repositório, por mês
            </div>
          </div>
          <div style={{ minWidth: 200 }}>
            <span className="ad-label">Cobrança deste mês</span>
            <div className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.03em' }}>
              R$ 747
            </div>
            <div style={{ fontSize: 13, color: 'var(--gl-muted)', marginTop: 6 }}>
              3 repositórios ativos
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button className="ad-btn g">Ver faturas</button>
            <button className="ad-btn">Mudar de plano</button>
          </div>
        </div>
      </Card>
    </>
  )
}
