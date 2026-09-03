'use client'
// Primitivos compartilhados pelas telas do painel do owner. Portado de
// ad-ui.jsx do handoff. `Kpi` renderiza travessão quando o valor é null;
// `Barra` só desenha quando há limite. Nenhum inventa número.
import { useState, type ReactNode } from 'react'
import { Ad } from './PainelIcons'

export function Card({
  titulo,
  sub,
  acao,
  children,
  flush,
  className = '',
}: {
  titulo?: ReactNode
  sub?: ReactNode
  acao?: ReactNode
  children: ReactNode
  flush?: boolean
  className?: string
}) {
  return (
    <section className={'pn-card ' + className}>
      {(titulo || acao) && (
        <header className="pn-ch">
          <h3>
            {titulo}
            {sub != null ? (
              <span className="s" style={{ fontWeight: 400, marginLeft: 8 }}>
                {sub}
              </span>
            ) : null}
          </h3>
          {acao}
        </header>
      )}
      {flush ? children : <div className="pn-pad">{children}</div>}
    </section>
  )
}

export function Kpi({
  l,
  v,
  n,
  tone,
  destaque,
}: {
  l: ReactNode
  v: ReactNode
  n?: ReactNode
  tone?: string
  destaque?: boolean
}) {
  return (
    <div className={'pn-kpi' + (destaque ? ' act' : '')}>
      <div className="l">{l}</div>
      <div className="v num">{v == null ? '—' : v}</div>
      <div className={'n ' + (tone || '')}>{n}</div>
    </div>
  )
}

export function Estado({ d, children }: { d: string; children: ReactNode }) {
  return (
    <span className="pn-st">
      <span className={'pn-d ' + d} />
      {children}
    </span>
  )
}

export function Barra({
  usado,
  limite,
  nome,
  nota,
}: {
  usado: number
  limite: number
  nome: ReactNode
  nota?: ReactNode
}) {
  // Trava o piso além do teto. Só o teto estava travado, e um percentual
  // negativo (que um leitor de cota torto pode gravar) virava `width: -5%` —
  // CSS inválido, declaração descartada, e o bloco sem largura ocupa 100% do
  // trilho. O pior modo de falha possível: número sem sentido virando a
  // afirmação mais alarmante da tela ("cota esgotada").
  const pct = Math.min(Math.max(Math.round((usado / limite) * 100), 0), 100)
  const tone = pct >= 90 ? 'b' : pct >= 75 ? 'w' : ''
  return (
    <div>
      <div className="pn-brow">
        <b>{nome}</b>
        <span className="num">
          {usado} / {limite}
        </span>
      </div>
      <div className="pn-bar">
        <i className={tone} style={{ width: pct + '%' }} />
      </div>
      {nota && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--gl-faint)' }}>{nota}</div>}
    </div>
  )
}

// Jargão só se o owner clicar.
export function Tecnico({
  children,
  rotulo = 'Ver detalhes técnicos',
}: {
  children?: ReactNode
  rotulo?: string
}) {
  const [ab, setAb] = useState(false)
  if (!children) return null
  return (
    <div>
      <button className="pn-more" onClick={() => setAb(!ab)} aria-expanded={ab}>
        <Ad n={ab ? 'chevU' : 'chevD'} s={14} />
        {ab ? 'Esconder detalhes técnicos' : rotulo}
      </button>
      {ab && <div className="pn-tech">{children}</div>}
    </div>
  )
}

/** Uma opção de resposta. `value` é o que o agente entende (e o que o painel
 *  envia); `label` é o texto do botão. Numa dúvida de exemplo os dois coincidem. */
export interface OpcaoDecisao {
  label: string
  value: string
}

export interface DecisaoView {
  id: string
  q: string
  ctx?: string
  agente: string
  quando: string
  /** número do pedido de origem, quando conhecido */
  pedido?: number
  op: OpcaoDecisao[]
  /**
   * `assumida` (L4-T4, D64): a dúvida foi ESCALADA ao dono, ele ficou 24h em
   * silêncio, e o RA formou uma suposição para o dev seguir em frente — o
   * dono ainda pode corrigir. Nunca conta como "esperando você" (não é mais
   * pendente), mas também não é a resposta DELE — o selo "Suposição do RA"
   * em `Decisao` avisa a diferença.
   */
  st: 'pendente' | 'respondida' | 'assumida'
  resposta?: string
  tec?: string
}

export function Decisao({
  d,
  responder,
  compacta,
}: {
  d: DecisaoView
  responder: (id: string, resposta: string) => void
  compacta?: boolean
}) {
  const [texto, setTexto] = useState('')
  const [livre, setLivre] = useState(false)
  // A resposta gravada é o `value`; para mostrar, volta ao rótulo do botão
  // quando bate (mesma regra do Telegram). Texto livre não tem rótulo.
  const rotuloDaResposta = d.op.find((o) => o.value === d.resposta)?.label ?? d.resposta
  return (
    <article className="pn-ask">
      <p className="q">{d.q}</p>
      {!compacta && d.ctx && <p className="ctx">{d.ctx}</p>}
      <div className="who">
        {d.agente} · {d.quando}
        {d.pedido ? ` · pedido #${d.pedido}` : ''}
      </div>
      {d.st === 'respondida' || d.st === 'assumida' ? (
        <div className="pn-answered">
          <span className="pn-label" style={{ color: 'var(--gl-accent-ink)', marginBottom: 4 }}>
            {d.st === 'assumida' ? 'Suposição do RA' : 'Sua resposta'}
          </span>
          <span style={{ fontSize: 14 }}>{rotuloDaResposta}</span>
          {d.st === 'assumida' && (
            <span className="pn-rs" style={{ display: 'block', marginTop: 4 }}>
              O dono não respondeu em 24h; o produto seguiu com esta suposição. Você ainda pode
              corrigir.
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="pn-qb">
            {d.op.map((o, i) => (
              <button
                key={o.value}
                className={'pn-q' + (i === 0 ? ' p' : '')}
                onClick={() => responder(d.id, o.value)}
              >
                {o.label}
              </button>
            ))}
            <button className="pn-q" onClick={() => setLivre(!livre)}>
              Escrever
            </button>
          </div>
          {livre && (
            <div style={{ marginTop: 12 }}>
              <textarea
                className="pn-field"
                rows={3}
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Explique a decisão em uma frase. O agente retoma de onde parou."
              />
              <button
                className="pn-btn a sm"
                style={{ marginTop: 10 }}
                disabled={!texto.trim()}
                onClick={() => responder(d.id, texto.trim())}
              >
                <Ad n="send" s={14} />
                Enviar
              </button>
            </div>
          )}
        </>
      )}
      {!compacta && <Tecnico>{d.tec}</Tecnico>}
    </article>
  )
}

export function Cabeca({ titulo, children }: { titulo: ReactNode; children: ReactNode }) {
  return (
    <div className="pn-head">
      <h1>{titulo}</h1>
      <p>{children}</p>
    </div>
  )
}

export function Chips<K extends string>({
  opcoes,
  valor,
  onChange,
}: {
  opcoes: [K, string][]
  valor: K
  onChange: (k: K) => void
}) {
  return (
    <div className="pn-chips">
      {opcoes.map(([k, l]) => (
        <button
          key={k}
          className={'pn-chip' + (valor === k ? ' on' : '')}
          onClick={() => onChange(k)}
        >
          {l}
        </button>
      ))}
    </div>
  )
}
