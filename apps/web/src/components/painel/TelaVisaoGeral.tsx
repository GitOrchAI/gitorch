'use client'
// Visão geral: responde "estamos no ritmo?" e mata a dúvida de "está parado?".
// Portado de TelaVisaoGeral.jsx. AO VIVO: Pulso, os KPIs de missão, quem está
// atuando e a prévia de pedidos. Ainda de exemplo (com selo): o Ritmo da
// semana e o Consumo de hoje — os dois esperam rota própria.
import { useSyncExternalStore } from 'react'
import { DEMO } from './painel-demo'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'

/** O que a Visão Geral usa de um pedido (subconjunto de PedidoDoPainel). */
interface PedidoResumo {
  numero: number
  titulo: string
  situacao: 'andando' | 'fechado'
  projeto: string
  partes: { total: number; concluidas: number }
}
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Ad } from './PainelIcons'
import { Card, Kpi, Estado, Barra, Decisao, Cabeca, type DecisaoView } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'
import type { TelaId } from './painel-nav'
import type { AgentesPayload, PulsoPayload } from './painel-tipos'
import { kpisDaVisaoGeral, type ResumoDeEntregas } from './painel-numeros'

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
  // Exemplo não finge que leu: sem isto, a tela de exemplo diria "nenhum
  // motor conectado" com a mesma cara de um dado real.
  cotaLida: false,
  motivoDaCota: null,
}

interface MissoesStats {
  stats?: { active: number; completed: number; failed: number }
}

/** A sprint que está valendo agora, como a rota devolve. */
interface SprintView {
  projeto: string
  titulo: string
  inicio: string
  fim: string
  dias: number
}

/** "27 ago" — o dono lê dia e mês, não ISO. */
function diaEMes(iso: string): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  return `${d.getUTCDate()} ${meses[d.getUTCMonth()]}`
}

/**
 * Sprint atual — substitui o "Ritmo da semana" do desenho original.
 *
 * O dono trocou semana por sprint: "quais sprints estão atuais e o que está
 * atuando". A sprint vive no quadro do cliente (campo de iteração do Projects
 * V2), e o painel lê de lá.
 *
 * Quando não há sprint, a tela DIZ isso. Antes ela desenhava uma semana com
 * meta inventada; um número que ninguém definiu é pior que número nenhum.
 */
function SprintAtual() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<
    { sprints: SprintView[]; configurados: number },
    { sprints?: SprintView[]; configurados?: number }
  >(ROTAS.sprint + filtroDeProjeto(projeto), {
    mapear: (b) => ({ sprints: b.sprints ?? [], configurados: b.configurados ?? 0 }),
    intervalo: 60000,
  })

  if (r.estado !== 'ok' || !r.dados) {
    return (
      <Card>
        <Estados r={r} o_que="a sprint atual">
          {() => null}
        </Estados>
      </Card>
    )
  }

  const { sprints, configurados } = r.dados

  if (sprints.length === 0) {
    // Duas situações diferentes, ditas de jeitos diferentes: nunca teve sprint,
    // ou tem sprint e hoje caiu no intervalo entre dois ciclos.
    return (
      <Card titulo="Sprint atual">
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--gl-muted)' }}>
          {configurados > 0
            ? 'Nenhum ciclo em andamento agora — o próximo começa em breve.'
            : 'Seus projetos ainda não têm sprint configurada. Assim que tiverem, o andamento aparece aqui.'}
        </p>
      </Card>
    )
  }

  return (
    <Card flush titulo={sprints.length > 1 ? 'Sprints em andamento' : 'Sprint atual'}>
      {sprints.map((s) => (
        <div key={`${s.projeto}-${s.titulo}`} className="pn-row static">
          <span className="pn-grow">
            <span className="pn-rt" style={{ display: 'block' }}>
              {s.titulo}
            </span>
            <span className="pn-rs">
              {s.projeto} · {diaEMes(s.inicio)} a {diaEMes(s.fim)}
            </span>
          </span>
          <span className="pn-tag">{s.dias} dias</span>
        </div>
      ))}
    </Card>
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

interface TimelinePayload {
  eventos: { texto: string; quando: string }[]
}

/**
 * Linha do tempo da auditoria (T15) — o que antes virava mensagem solta no
 * Telegram ("N entregas barradas", "voltou para a fila"...) agora fica
 * registrado aqui. O dono só recebe Telegram para o que é executivo de
 * verdade; o resto vira histórico consultável.
 */
function LinhaDoTempo() {
  const r = usePainelBusca<TimelinePayload>(ROTAS.timeline, {
    vazio: (d) => d.eventos.length === 0,
    intervalo: 30000,
  })
  return (
    <Card flush titulo="Linha do tempo">
      <Estados r={r} o_que="a linha do tempo" vazio="Nada de auditoria registrado ainda.">
        {(d) =>
          d.eventos.map((e, i) => (
            <div key={i} className="pn-row static">
              <span className="pn-grow">
                <span className="pn-rt" style={{ display: 'block' }}>
                  {e.texto}
                </span>
              </span>
              <span className="pn-rs" style={{ flex: 'none' }}>
                {fraseDeTempo(haQuantoTempo(e.quando))}
              </span>
            </div>
          ))
        }
      </Estados>
    </Card>
  )
}

function haQuantoTempo(iso: string): number | null {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

/**
 * Os quatro números do topo.
 *
 * "Entregue no total" lê /painel/entregas — a MESMA rota, com o MESMO filtro
 * de projeto, que alimenta a aba Entregas. Antes lia `missions.completed`, e
 * era por isso que a mesma tela conseguia dizer "Entregue no total: 4521" no
 * topo e "PRONTAS: 0" na aba ao lado: duas fontes respondendo a mesma
 * pergunta. Os rótulos e as notas moram em painel-numeros.ts, que tem teste;
 * aqui só se desenha.
 */
function Kpis({ decisoesPendentes }: { decisoesPendentes: number }) {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const e = usePainelBusca<ResumoDeEntregas, { prontas?: number; total?: number }>(
    ROTAS.entregas + filtroDeProjeto(projeto),
    {
      // Campo ausente é DESCONHECIDO, nunca zero: "de 0 que passaram pela sua
      // régua" ao lado de um número real é o default vazio que já nos custou caro.
      mapear: (b) => ({ prontas: b.prontas ?? null, total: b.total ?? null }),
      intervalo: 30000,
    }
  )
  const m = usePainelBusca<MissoesStats>(ROTAS.missoes, { intervalo: 15000 })

  const kpis = kpisDaVisaoGeral({
    entregas: e.estado === 'ok' && e.dados ? e.dados : null,
    rodadas: m.estado === 'ok' && m.dados?.stats ? m.dados.stats : null,
    decisoesPendentes,
  })

  return (
    <div className="pn-kpis">
      {kpis.map((k) => (
        <Kpi key={k.l} l={k.l} v={k.v} n={k.n} tone={k.tone} destaque={k.destaque} />
      ))}
    </div>
  )
}

/**
 * Os 5 pedidos mais recentes, ao vivo (GET /api/v1/painel/pedidos).
 *
 * Era exemplo até a rota existir. Deixar exemplo aqui e dado real na tela de
 * Pedidos mostraria a MESMA informação de dois jeitos diferentes — o dono
 * compararia as duas e não saberia em qual acreditar.
 *
 * As colunas de responsável e previsão saíram: não têm fonte. Entram de volta
 * quando houver de onde ler.
 */
function PedidosRecentes({ ir }: { ir: (id: TelaId) => void }) {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<PedidoResumo[], { pedidos?: PedidoResumo[] }>(
    ROTAS.pedidos + filtroDeProjeto(projeto),
    { mapear: (b) => (b.pedidos ?? []).slice(0, 5), vazio: (d) => d.length === 0 }
  )
  return (
    <Card
      flush
      titulo="Seus pedidos"
      acao={
        <button className="pn-link" onClick={() => ir('pedidos')}>
          Ver todos <Ad n="arrow" s={13} />
        </button>
      }
    >
      <Estados r={r} o_que="seus pedidos" vazio="Você ainda não fez nenhum pedido.">
        {(pedidos) => (
          <div className="pn-tw">
            <table>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Situação</th>
                  <th>Andamento</th>
                </tr>
              </thead>
              <tbody>
                {pedidos.map((p) => (
                  <tr key={`${p.projeto}#${p.numero}`}>
                    <td>
                      <b>{p.titulo}</b>
                      <div className="m">{p.projeto}</div>
                    </td>
                    <td className="pn-nowrap">
                      <Estado d={p.situacao === 'fechado' ? 'g' : ''}>
                        {p.situacao === 'fechado' ? 'Fechado' : 'Andando'}
                      </Estado>
                    </td>
                    <td className="pn-nowrap" style={{ color: 'var(--gl-muted)' }}>
                      {p.situacao === 'fechado'
                        ? 'fechado no GitHub'
                        : p.partes.total === 0
                          ? 'ainda sendo planejado'
                          : `${p.partes.concluidas} de ${p.partes.total} partes`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Estados>
    </Card>
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
        Aqui está o ritmo dos seus pedidos: o que já ficou pronto pela sua régua, o que os agentes
        estão rodando agora e o que espera uma decisão sua.
      </Cabeca>

      <SprintAtual />
      <Pulso />

      <Kpis decisoesPendentes={decisoesPendentes.length} />

      <div className="pn-2">
        <PedidosRecentes ir={ir} />

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
      <LinhaDoTempo />
    </>
  )
}
