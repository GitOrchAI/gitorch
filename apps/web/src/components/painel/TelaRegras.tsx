'use client'
// Regras: os limites que os agentes respeitam. Duas não podem ser desligadas.
// VISUAL nesta leva: os interruptores desenham e guardam o estado localmente;
// ligar de verdade na governança do backend é leva 2. Portado de
// TelaGovernanca.jsx.
import { useState } from 'react'
import { DEMO } from './painel-demo'
import { Cabeca, Card } from './PainelUI'

function Interruptor({
  on,
  trava,
  onToggle,
}: {
  on: boolean
  trava?: boolean
  onToggle?: () => void
}) {
  return (
    <button
      onClick={trava ? undefined : onToggle}
      disabled={trava}
      aria-pressed={on}
      style={{
        flex: 'none',
        width: 42,
        height: 24,
        borderRadius: 999,
        border: '1px solid ' + (on ? 'var(--gl-accent)' : 'var(--gl-hair-strong)'),
        background: on ? 'var(--gl-accent)' : 'var(--gl-surface-2)',
        position: 'relative',
        cursor: trava ? 'not-allowed' : 'pointer',
        transition: 'all .2s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: on ? 'var(--gl-on-accent)' : 'var(--gl-faint)',
          transition: 'left .2s cubic-bezier(.2,.7,.3,1)',
        }}
      />
    </button>
  )
}

interface RegraView {
  t: string
  d: string
  on: boolean
  trava: boolean
}

export function TelaRegras() {
  const [regras, setRegras] = useState<RegraView[]>(DEMO.regras.map((r) => ({ ...r })))
  const alternar = (i: number) =>
    setRegras((rs) => rs.map((r, k) => (k === i ? { ...r, on: !r.on } : r)))

  return (
    <>
      <Cabeca titulo="Regras">
        Os limites que os agentes respeitam. Duas delas não podem ser desligadas — são o que garante
        que nada entre em produção sem verificação.
      </Cabeca>

      <Card flush titulo="Em vigor">
        {regras.map((r, i) => (
          <div key={r.t} className="ad-row static" style={{ alignItems: 'flex-start' }}>
            <span className="ad-grow">
              <span className="ad-rt" style={{ display: 'block', whiteSpace: 'normal' }}>
                {r.t}
              </span>
              <span className="ad-rs" style={{ lineHeight: 1.5 }}>
                {r.d}
              </span>
              {r.trava && (
                <span className="ad-tag" style={{ marginTop: 8 }}>
                  Obrigatória
                </span>
              )}
            </span>
            <Interruptor on={r.on} trava={r.trava} onToggle={() => alternar(i)} />
          </div>
        ))}
      </Card>

      <Card titulo="Autonomia dos agentes">
        <p
          style={{ margin: '0 0 18px', fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}
        >
          Quanto cada função decide sozinha antes de perguntar. Mais autonomia significa menos
          interrupções para você, e menos controle sobre o caminho.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(
            [
              ['Produto', 'Prioriza a fila sozinho', 70],
              ['Planejamento', 'Divide pedidos sozinho até 3 partes', 55],
              ['Desenvolvimento', 'Escolhe a implementação, pergunta sobre serviço externo', 60],
              ['Qualidade', 'Nunca aprova sozinho', 20],
            ] as [string, string, number][]
          ).map(([n, d, v]) => (
            <div key={n}>
              <div className="ad-brow">
                <b>{n}</b>
                <span className="num">{v}%</span>
              </div>
              <div className="ad-bar">
                <i style={{ width: v + '%' }} />
              </div>
              <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--gl-faint)' }}>{d}</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}
