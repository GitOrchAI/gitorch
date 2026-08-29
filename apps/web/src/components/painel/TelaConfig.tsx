'use client'
// Configurações: conta, avisos e aparência. VISUAL nesta leva — só o tema liga
// de verdade (via props do shell, que persiste em localStorage). Convidar
// sócio, trocar plano e mudar os avisos no backend é leva 2. Portado de
// TelaConfig.jsx.
import { useState, type ReactNode } from 'react'
import { DEMO } from './painel-demo'
import { Cabeca, Card, Chips } from './PainelUI'
import type { Tema } from './painel-tema'

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

function Linha({
  titulo,
  desc,
  children,
}: {
  titulo: ReactNode
  desc: ReactNode
  children: ReactNode
}) {
  return (
    <div className="pn-row static" style={{ alignItems: 'flex-start' }}>
      <span className="pn-grow">
        <span className="pn-rt" style={{ display: 'block', whiteSpace: 'normal' }}>
          {titulo}
        </span>
        <span className="pn-rs" style={{ lineHeight: 1.5 }}>
          {desc}
        </span>
      </span>
      <span style={{ flex: 'none' }}>{children}</span>
    </div>
  )
}

export function TelaConfig({ tema, setTema }: { tema: Tema; setTema: (t: Tema) => void }) {
  const [tg, setTg] = useState(true)
  const [email, setEmail] = useState(false)

  return (
    <>
      <Cabeca titulo="Configurações">
        Conta, avisos e aparência. Alterações valem só para você.
      </Cabeca>

      <Card flush titulo="Conta">
        <Linha titulo={DEMO.conta} desc={`Plano ${DEMO.plano} · 3 projetos ativos`}>
          <button className="pn-btn g sm">Gerenciar</button>
        </Linha>
        <Linha titulo="GitHub conectado" desc="Instalado em acme · autorizado por você">
          <span className="pn-tag on">Ativo</span>
        </Linha>
        <Linha
          titulo="Sócios com acesso"
          desc="Duas pessoas veem o painel, sem permissão de configurar"
        >
          <button className="pn-btn g sm">Convidar</button>
        </Linha>
      </Card>

      <Card flush titulo="Onde você quer ser avisado">
        <Linha titulo="Telegram" desc="Decisões e entregas chegam no celular na hora">
          <Interruptor on={tg} onToggle={() => setTg(!tg)} />
        </Linha>
        <Linha titulo="Resumo por e-mail" desc="Uma vez por semana, com o que entrou em produção">
          <Interruptor on={email} onToggle={() => setEmail(!email)} />
        </Linha>
        <Linha titulo="No painel" desc="Sempre ligado: o contador de decisões pendentes">
          <Interruptor on trava />
        </Linha>
      </Card>

      <Card flush titulo="Aparência">
        <Linha titulo="Tema" desc="Claro para o dia, escuro para a noite">
          <Chips
            valor={tema}
            onChange={setTema}
            opcoes={[
              ['light', 'Claro'],
              ['dark', 'Escuro'],
            ]}
          />
        </Linha>
        <Linha titulo="Idioma" desc="O painel e os avisos usam este idioma">
          <Chips
            valor="pt"
            onChange={() => {}}
            opcoes={[
              ['pt', 'Português'],
              ['en', 'English'],
              ['es', 'Español'],
            ]}
          />
        </Linha>
      </Card>

      <Card flush titulo="Motores conectados">
        {DEMO.motores.map((m) => (
          <Linha key={m.nome} titulo={m.nome} desc={`${m.tipo} · ${m.nota}`}>
            <span className="pn-tag on">Conectado</span>
          </Linha>
        ))}
      </Card>
    </>
  )
}
