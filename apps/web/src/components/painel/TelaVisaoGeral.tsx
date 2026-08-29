'use client'
// Visão geral: responde "estamos no ritmo?" e mata a dúvida de "está parado?".
// Portado de TelaVisaoGeral.jsx. Nesta leva: Pulso e os KPIs de missão são
// AO VIVO; Ritmo e a prévia de pedidos ficam de exemplo (selo).
import { DEMO, DIAS } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Ad } from './PainelIcons'
import { Card, Kpi, Estado, Barra, Decisao, Cabeca, type DecisaoView } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'
import type { TelaId } from './painel-nav'
import type { AgentesPayload, PulsoPayload } from './painel-tipos'

function fraseDeTempo(haSegundos: number | null): string | null {
  if (haSegundos == null) return null
  if (haSegundos < 60) return 'agora'
  const min = Math.floor(haSegundos / 60)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} dia(s)`
}

// Estado de exemplo ('go'/'wait'/'block'/'idle') → o enum do servidor.
const ESTADO_DEMO: Record<string, AgentesPayload['atuando'][number]['estado']> = {
  go: 'trabalhando',
  wait: 'esperando_voce',
  block: 'bloqueado',
  idle: 'ocioso',
}

const AGENTES_DEMO: AgentesPayload = {
  atuando: DEMO.atuando.map((a, i) => ({
    id: 'demo-' + i,
    nome: a.nome,
    papel: a.papel,
    estado: ESTADO_DEMO[a.estado] ?? 'ocioso',
    descricao: a.o_que,
    projeto: a.repo,
    desde: a.desde,
    progresso: a.progresso,
  })),
  motores: [],
}

interface MissoesStats {
  stats?: { active: number; completed: number; failed: number }
}

function Ritmo() {
  // /painel/ritmo é leva 2 — mostra o exemplo com selo enquanto a rota não existe.
  const r = usePainelBusca<typeof DEMO.semana>(ROTAS.ritmo, {
    demo: DEMO.semana,
    exemploQuandoAusente: true,
    intervalo: 60000,
  })
  if (r.estado !== 'ok' || !r.dados) {
    return (
      <Card>
        <Estados r={r} o_que="o ritmo da semana">
          {() => null}
        </Estados>
      </Card>
    )
  }
  const s = r.dados
  const ok = s.verdito === 'no ritmo'
  const pct = Math.round((s.entregue / s.meta) * 100)
  return (
    <div className="pn-pace">
      <div className="pn-pace-t">
        <div>
          <p className="pn-eyebrow">
            Ritmo da semana · {s.rotulo}
            <SeloDemo mostrar={!!r.demo} />
          </p>
          <div className="pn-pace-v num" style={{ marginTop: 10 }}>
            {s.entregue}
            <span> / {s.meta} entregas</span>
          </div>
          <p className="pn-pace-l">{s.verditoNota}</p>
        </div>
        <span className={'pn-verdict ' + (ok ? 'ok' : 'warn')}>
          <Ad n={ok ? 'check' : 'alert'} s={15} />
          {ok ? 'No ritmo' : 'Atrasado'}
        </span>
      </div>
      <div className="pn-track">
        {s.porDia.map((n, i) => (
          <i
            key={i}
            className={n > 0 ? 'done' : i === s.hojeIndex ? 'today' : ''}
            title={n + ' entrega(s)'}
          />
        ))}
      </div>
      <div className="pn-track-l">
        {DIAS.map((d, i) => (
          <span key={d} className={i === s.hojeIndex ? 'on' : ''}>
            {d}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--gl-faint)' }}>
        {pct}% da meta cumprida · cada bloco é um dia, preenchido quando houve entrega
      </div>
    </div>
  )
}

function Pulso() {
  // /painel/pulso, re-consultada a cada 20s. É escopada pelo DONO (resolveOwnerId).
  // Não usamos o SSE de /api/events aqui: ele é filtrado por wingId, e num wing
  // com mais de um dono a faixa mostraria atividade alheia — quebra o escopo.
  const r = usePainelBusca<PulsoPayload>(ROTAS.pulso, { intervalo: 20000 })
  const p = r.estado === 'ok' && r.dados ? r.dados : null
  if (!p || p.ultimo_sinal_em == null) {
    return (
      <div className="pn-pulse cold">
        <span className="pn-d idle" />
        <span>
          <b>Nenhum sinal ainda.</b> Assim que um agente se mexer, aparece aqui.
        </span>
      </div>
    )
  }
  return (
    <div className={'pn-pulse' + (p.quente ? '' : ' cold')}>
      <span className="pn-live" />
      <span>
        <b>{p.quente ? 'Andando agora.' : 'Sem sinal recente.'}</b> Último sinal{' '}
        {fraseDeTempo(p.ha_segundos)}: {p.descricao}.
      </span>
    </div>
  )
}

function Atuando({ ir }: { ir: (id: TelaId) => void }) {
  const r = usePainelBusca<AgentesPayload>(ROTAS.agentes, {
    demo: AGENTES_DEMO,
    intervalo: 15000,
  })
  return (
    <Card
      flush
      titulo="Quem está trabalhando agora"
      sub={r.demo ? 'exemplo' : null}
      acao={
        <button className="pn-link" onClick={() => ir('projetos')}>
          Por projeto <Ad n="arrow" s={13} />
        </button>
      }
    >
      <Estados r={r} o_que="o estado dos agentes" vazio="Nenhum agente com tarefa agora.">
        {(d) =>
          d.atuando.map((a) => (
            <div key={a.id} className="pn-row static">
              <span
                className={'pn-d ' + estadoParaClasse(a.estado)}
                style={{ marginTop: 6, alignSelf: 'flex-start' }}
              />
              <span className="pn-grow">
                <span className="pn-rt" style={{ display: 'block' }}>
                  {a.nome}
                </span>
                <span className="pn-rs">{a.descricao}</span>
                {a.progresso != null && (
                  <span className="pn-bar" style={{ maxWidth: 210 }}>
                    <i style={{ width: a.progresso + '%' }} />
                  </span>
                )}
              </span>
              <span style={{ flex: 'none', textAlign: 'right' }}>
                <span className="pn-tag">{a.papel}</span>
                <span className="pn-rs" style={{ display: 'block' }}>
                  {a.desde}
                </span>
              </span>
            </div>
          ))
        }
      </Estados>
    </Card>
  )
}

// O enum do servidor ('trabalhando'|'esperando_voce'|'bloqueado'|'ocioso') e o
// vocabulário de exemplo ('go'|'wait'|'block'|'idle') caem na mesma cor.
function estadoParaClasse(estado: string): string {
  return (
    { trabalhando: 'go', esperando_voce: 'wait', bloqueado: 'block', ocioso: 'idle' }[estado] ??
    estado
  )
}

function Kpis({ decisoesPendentes }: { decisoesPendentes: number }) {
  const m = usePainelBusca<MissoesStats>(ROTAS.missoes, { intervalo: 15000 })
  const stats = m.estado === 'ok' && m.dados ? m.dados.stats : null
  const kpis = [
    {
      l: 'Entregue no total',
      v: stats ? stats.completed : null,
      n: stats ? 'concluídas até agora' : 'ainda carregando',
      tone: 'g',
    },
    {
      l: 'Esperando sua decisão',
      v: decisoesPendentes,
      n: decisoesPendentes ? 'responder destrava o trabalho' : 'nada pendente',
      tone: 'w',
      destaque: decisoesPendentes > 0,
    },
    {
      l: 'Em andamento',
      v: stats ? stats.active : null,
      n: 'em execução ou na fila',
      tone: '',
    },
    {
      l: 'Travado',
      v: stats ? stats.failed : null,
      n: stats && stats.failed ? 'precisa de revisão manual' : 'nada travado',
      tone: 'b',
    },
  ]
  return (
    <div className="pn-kpis">
      {kpis.map((k) => (
        <Kpi key={k.l} {...k} />
      ))}
    </div>
  )
}

export function TelaVisaoGeral({
  ir,
  decisoesPendentes,
  responder,
}: {
  ir: (id: TelaId) => void
  decisoesPendentes: DecisaoView[]
  responder: (id: string, resposta: string) => void
}) {
  return (
    <>
      <Cabeca titulo="Bom dia.">
        Aqui está o ritmo dos seus pedidos: o que já entrou em produção, o que segue em andamento e
        o que espera uma decisão sua.
      </Cabeca>

      <Ritmo />
      <Pulso />

      <Kpis decisoesPendentes={decisoesPendentes.length} />

      <div className="pn-2">
        <Card
          flush
          titulo="Seus pedidos"
          sub={<SeloDemo mostrar />}
          acao={
            <button className="pn-link" onClick={() => ir('pedidos')}>
              Ver todos <Ad n="arrow" s={13} />
            </button>
          }
        >
          <div className="pn-tw">
            <table>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Situação</th>
                  <th>Responsável</th>
                  <th>Previsão</th>
                </tr>
              </thead>
              <tbody>
                {DEMO.pedidos.slice(0, 5).map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.t}</b>
                      <div className="m">
                        {p.repo} · pedido {p.quando}
                      </div>
                    </td>
                    <td className="pn-nowrap">
                      <Estado d={p.d}>{p.sit}</Estado>
                    </td>
                    <td className="pn-nowrap">{p.resp}</td>
                    <td className="pn-nowrap" style={{ color: 'var(--gl-muted)' }}>
                      {p.prev}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card
            flush
            titulo="Precisa de você"
            sub={decisoesPendentes.length > 0 ? decisoesPendentes.length : null}
            acao={
              <button className="pn-link" onClick={() => ir('decisoes')}>
                Todas <Ad n="arrow" s={13} />
              </button>
            }
          >
            {decisoesPendentes.length === 0 ? (
              <div className="pn-empty">Nada esperando por você agora.</div>
            ) : (
              decisoesPendentes
                .slice(0, 2)
                .map((d) => <Decisao key={d.id} d={d} responder={responder} compacta />)
            )}
          </Card>

          <Card
            titulo="Consumo de hoje"
            sub={<SeloDemo mostrar />}
            acao={
              <button className="pn-link" onClick={() => ir('custos')}>
                Detalhar <Ad n="arrow" s={13} />
              </button>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
              {DEMO.motores.slice(0, 3).map((m) => (
                <Barra key={m.nome} usado={m.usado} limite={m.limite} nome={m.nome} />
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Atuando ir={ir} />
    </>
  )
}
