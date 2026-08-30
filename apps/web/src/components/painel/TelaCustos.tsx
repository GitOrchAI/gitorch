'use client'
// Custos e limites: você usa a sua própria assinatura de cada ferramenta. O
// que o painel controla é quanto de cada cota já foi gasto. A cota dos motores
// é AO VIVO (best-effort — sem store de consumo persistida a tela degrada com
// honestidade); os KPIs de topo, o esforço por projeto e o plano ficam de
// exemplo (leva 2). Portado de TelaCustos.jsx.
import { useSyncExternalStore } from 'react'
import { DEMO } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Kpi, Barra } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'
import type { MotorCota } from './painel-tipos'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'

interface Distribuicao {
  mediana: number
  p90: number
  maximo: number
}
interface CicloView {
  entregas: number
  dePrimeira: number
  cutucadas: Distribuicao
  tentativas: Distribuicao
  falhasDeMerge: Distribuicao
  horasAteFechar: Distribuicao | null
  naoMedido: string[]
}

/** Um número medido, com a mediana em destaque e a cauda ao lado. */
function Medida({ rotulo, d, sufixo }: { rotulo: string; d: Distribuicao; sufixo?: string }) {
  return (
    <div>
      <span className="pn-label">{rotulo}</span>
      <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
        {d.mediana}
        {sufixo ?? ''}
      </div>
      <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 2 }}>
        {/* A cauda ao lado da mediana, sempre. A mediana sozinha esconde a dor,
            e a média sozinha esconde o caso típico — as duas juntas é que
            descrevem o ciclo. */}
        90% abaixo de {d.p90}
        {sufixo ?? ''} · pior {d.maximo}
        {sufixo ?? ''}
      </div>
    </div>
  )
}

/**
 * Quanto o ciclo custa, contando o retrabalho.
 *
 * O raciocínio do dono: "se o modelo é 20x melhor que humano, mas teve 5
 * retrabalhos, o ganho real não é 20x". Por isso a conta desconta o retrabalho
 * — e por isso o número vem do NOSSO banco, nunca de um multiplicador de fora.
 */
function ONossoCiclo() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<CicloView, CicloView>(ROTAS.ciclo + filtroDeProjeto(projeto), {
    vazio: (d) => d.entregas === 0,
  })

  return (
    <Card
      titulo="O nosso ciclo, com o retrabalho descontado"
      sub="Medido no seu banco, não estimado."
    >
      <Estados
        r={r}
        o_que="a medição do ciclo"
        vazio="Nenhuma entrega ainda para medir. A conta aparece com a primeira."
      >
        {(c) => (
          <>
            <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
              <div>
                <span className="pn-label">Saem de primeira</span>
                <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>
                  {Math.round((c.dePrimeira / c.entregas) * 100)}%
                </div>
                <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 2 }}>
                  {c.dePrimeira} de {c.entregas}, sem ninguém empurrar
                </div>
              </div>
              <Medida rotulo="Cutucadas por entrega" d={c.cutucadas} />
              <Medida rotulo="Falhas ao mesclar" d={c.falhasDeMerge} />
              {c.horasAteFechar && (
                <Medida rotulo="Horas até fechar" d={c.horasAteFechar} sufixo="h" />
              )}
            </div>

            {/* Um travessão sem explicação é indistinguível de zero para quem
                lê. O que não dá para medir aparece dito. */}
            {c.naoMedido.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <span className="pn-label">Ainda não consigo medir</span>
                <ul
                  style={{
                    margin: '6px 0 0',
                    paddingLeft: 18,
                    fontSize: 13,
                    color: 'var(--gl-muted)',
                  }}
                >
                  {c.naoMedido.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Estados>
    </Card>
  )
}

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

      <ONossoCiclo />

      <p className="pn-eyebrow">
        Resumo do mês
        <SeloDemo mostrar />
      </p>
      <div className="pn-kpis">
        <Kpi l="Tarefas hoje" v={55} n="somando todos os motores" />
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
            <div className="pn-3">
              {d.map((m) =>
                m.limite == null ? (
                  <div key={m.nome}>
                    <div className="pn-brow">
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
        <div className="pn-tw">
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
                  <td className="num pn-nowrap">{r.tarefas}</td>
                  <td style={{ minWidth: 200 }}>
                    <div className="pn-brow">
                      <span className="num">{r.pct}%</span>
                    </div>
                    <div className="pn-bar" style={{ marginTop: 4 }}>
                      <i style={{ width: r.pct + '%' }} />
                    </div>
                  </td>
                  <td className="num pn-nowrap">{r.entregas}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card titulo="Seu plano" sub={<SeloDemo mostrar />}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 200 }}>
            <span className="pn-label">Plano atual</span>
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.03em' }}>
              {DEMO.plano}
            </div>
            <div style={{ fontSize: 13, color: 'var(--gl-muted)', marginTop: 6 }}>
              R$ 249 por repositório, por mês
            </div>
          </div>
          <div style={{ minWidth: 200 }}>
            <span className="pn-label">Cobrança deste mês</span>
            <div className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.03em' }}>
              R$ 747
            </div>
            <div style={{ fontSize: 13, color: 'var(--gl-muted)', marginTop: 6 }}>
              3 repositórios ativos
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button className="pn-btn g">Ver faturas</button>
            <button className="pn-btn">Mudar de plano</button>
          </div>
        </div>
      </Card>
    </>
  )
}
