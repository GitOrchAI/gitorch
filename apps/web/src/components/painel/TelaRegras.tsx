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
import { useState } from 'react'
import { DEMO } from './painel-demo'
import { ROTAS, salvarDuvidaConfig } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Chips } from './PainelUI'
import { SeloDemo, Estados } from './PainelEstados'

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

// ESTEIRA-T14 (decisão do dono 29/08) — quando o QA não sabe responder uma
// dúvida técnica do dev assíncrono, quanto o dono quer ver disso no chat. AO
// VIVO nesta leva: lê e grava runtimeConfig.perguntasAoDono de verdade (POST
// /api/v1/painel/duvida-config) — por isso NÃO leva SeloDemo nem Interruptor
// desabilitado, ao contrário do resto desta tela.
const OPCOES_PERGUNTAS_AO_DONO: [string, string][] = [
  ['so-executivo', 'Só decisão de negócio'],
  ['executivo-e-tecnico-bloqueante', 'Negócio + bloqueio técnico'],
  ['tudo', 'Tudo'],
]

const DESC_POR_OPCAO: Record<string, string> = {
  'so-executivo':
    'Você só vê pergunta que é decisão SUA. O time (QA e RA) resolve tudo que é técnico sozinho.',
  'executivo-e-tecnico-bloqueante':
    'Além da decisão sua, você também é avisado sempre que o time (QA e RA, que tentam primeiro) resolve um bloqueio técnico sozinho.',
  tudo: 'Você vê tudo, inclusive as dúvidas técnicas que o time já resolveu sozinho (sem bloquear nada).',
}

interface ProjetoBruto {
  id: string
  name: string
  description?: string | null
  runtimeConfig?: { perguntasAoDono?: string } | null
}
interface ProjetoDuvidaView {
  id: string
  nome: string
  perguntasAoDono: string
}

function politicaAtual(runtimeConfig: ProjetoBruto['runtimeConfig']): string {
  const v = runtimeConfig?.perguntasAoDono
  return v === 'executivo-e-tecnico-bloqueante' || v === 'tudo' ? v : 'so-executivo'
}

function CardDuvidasDoDev() {
  const r = usePainelBusca<ProjetoDuvidaView[], { data?: ProjetoBruto[] }>(ROTAS.repos, {
    mapear: (b) =>
      (b.data ?? []).map((p) => ({
        id: p.id,
        nome: p.description || p.name,
        perguntasAoDono: politicaAtual(p.runtimeConfig),
      })),
    vazio: (d) => d.length === 0,
  })
  // Estado local por projeto: valor otimista (a tela muda na hora do clique,
  // não espera o servidor) + o que está salvando + o erro, se a gravação
  // falhar (aí volta pro valor de antes — nunca deixa a tela mentir).
  const [valores, setValores] = useState<Record<string, string>>({})
  const [salvando, setSalvando] = useState<Record<string, boolean>>({})
  const [erros, setErros] = useState<Record<string, string>>({})

  const valorDe = (p: ProjetoDuvidaView): string => valores[p.id] ?? p.perguntasAoDono

  async function mudar(p: ProjetoDuvidaView, novo: string) {
    const anterior = valorDe(p)
    if (novo === anterior) return
    setValores((v) => ({ ...v, [p.id]: novo }))
    setErros((e) => ({ ...e, [p.id]: '' }))
    setSalvando((s) => ({ ...s, [p.id]: true }))
    const resultado = await salvarDuvidaConfig(p.id, novo)
    setSalvando((s) => ({ ...s, [p.id]: false }))
    if (!resultado.ok) {
      // Falhou: volta pro valor de antes — o controle nunca fica mostrando
      // algo que não foi salvo de verdade.
      setValores((v) => ({ ...v, [p.id]: anterior }))
      setErros((e) => ({ ...e, [p.id]: resultado.erro }))
    }
  }

  return (
    <Card flush titulo="Dúvidas do dev assíncrono" sub="Ao vivo">
      <p style={{ margin: '0 0 18px', fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}>
        Quando o Jules trava numa pergunta, o QA responde o que é técnico e só sobe a você o que é
        decisão de negócio. Escolha, por projeto, o quanto disso você quer ver no chat.
      </p>
      <Estados r={r} o_que="os projetos" vazio="Nenhum projeto ligado ainda.">
        {(projetos) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {projetos.map((p) => (
              <div key={p.id} className="pn-row static" style={{ alignItems: 'flex-start' }}>
                <span className="pn-grow">
                  <span className="pn-rt" style={{ display: 'block', whiteSpace: 'normal' }}>
                    {p.nome}
                  </span>
                  <span className="pn-rs" style={{ lineHeight: 1.5 }}>
                    {DESC_POR_OPCAO[valorDe(p)]}
                    {salvando[p.id] && ' · Salvando…'}
                  </span>
                  {erros[p.id] && (
                    <span className="pn-rs" style={{ color: 'var(--gl-danger, #c0392b)' }}>
                      {erros[p.id]}
                    </span>
                  )}
                </span>
                <Chips
                  valor={valorDe(p)}
                  onChange={(v) => void mudar(p, v)}
                  opcoes={OPCOES_PERGUNTAS_AO_DONO}
                />
              </div>
            ))}
          </div>
        )}
      </Estados>
    </Card>
  )
}

export function TelaRegras() {
  const regras: readonly RegraView[] = DEMO.regras

  return (
    <>
      <Cabeca titulo="Regras">
        Os limites que os agentes respeitam. Duas delas não podem ser desligadas — são o que garante
        que nada entre em produção sem verificação.
      </Cabeca>

      <CardDuvidasDoDev />

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
