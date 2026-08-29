'use client'
// Regras: os limites que os agentes respeitam.
//
// TUDO nesta tela é EXEMPLO nesta leva — não existe rota de governança ainda.
// Por isso os dois cards levam o selo "dado de exemplo" e os interruptores
// vêm DESABILITADOS: antes eles ligavam e desligavam na tela sem salvar nada,
// o que fazia o dono acreditar que tinha mudado uma regra de produção. Um
// controle que não persiste é pior que controle nenhum. Volta a ser
// interativo junto com a rota de governança (leva 2). Portado de
// TelaGovernanca.jsx.
import { DEMO } from './painel-demo'
import { Cabeca, Card } from './PainelUI'
import { SeloDemo } from './PainelEstados'

/** Motivo dos interruptores desabilitados, visível no hover. */
const INERTE = 'Ainda não salva — ligar regras de verdade entra numa próxima leva.'

function Interruptor({ on, trava, rotulo }: { on: boolean; trava?: boolean; rotulo: string }) {
  return (
    <button
      disabled
      aria-pressed={on}
      aria-label={rotulo}
      title={trava ? 'Obrigatória: não pode ser desligada.' : INERTE}
      style={{
        opacity: trava ? 1 : 0.45,
        flex: 'none',
        width: 42,
        height: 24,
        borderRadius: 999,
        border: '1px solid ' + (on ? 'var(--gl-accent)' : 'var(--gl-hair-strong)'),
        background: on ? 'var(--gl-accent)' : 'var(--gl-surface-2)',
        position: 'relative',
        cursor: 'not-allowed',
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
  const regras: readonly RegraView[] = DEMO.regras

  return (
    <>
      <Cabeca titulo="Regras">
        Os limites que os agentes respeitam. Duas delas não podem ser desligadas — são o que garante
        que nada entre em produção sem verificação.
      </Cabeca>

      <Card flush titulo="Em vigor" sub={<SeloDemo mostrar />}>
        {regras.map((r) => (
          <div key={r.t} className="pn-row static" style={{ alignItems: 'flex-start' }}>
            <span className="pn-grow">
              <span className="pn-rt" style={{ display: 'block', whiteSpace: 'normal' }}>
                {r.t}
              </span>
              <span className="pn-rs" style={{ lineHeight: 1.5 }}>
                {r.d}
              </span>
              {r.trava && (
                <span className="pn-tag" style={{ marginTop: 8 }}>
                  Obrigatória
                </span>
              )}
            </span>
            <Interruptor on={r.on} trava={r.trava} rotulo={r.t} />
          </div>
        ))}
      </Card>

      <Card titulo="Autonomia dos agentes" sub={<SeloDemo mostrar />}>
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
              <div className="pn-brow">
                <b>{n}</b>
                <span className="num">{v}%</span>
              </div>
              <div className="pn-bar">
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
