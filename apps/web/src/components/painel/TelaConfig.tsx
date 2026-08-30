'use client'
// Configurações: conta, avisos e aparência. Portado de TelaConfig.jsx.
//
// O QUE LIGA DE VERDADE nesta leva: a identidade da conta (e-mail da sessão,
// GET /api/v1/auth/me) e o tema (props do shell, persistido em localStorage).
//
// O RESTO É EXEMPLO e a tela DIZ isso: cada card de exemplo leva o selo "dado
// de exemplo" e todo controle que não salva vem desabilitado com o motivo no
// title. Motivo: um painel que desenha "Plano Cloud Pro · 3 projetos ativos"
// ou um interruptor que volta sozinho no reload está mentindo para o dono.
// Onde não existe fonte, o texto NÃO afirma fato — descreve o que a linha vai
// mostrar quando a rota existir (leva 2: plano, sócios, avisos, motores).
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DEMO } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Chips } from './PainelUI'
import { SeloDemo } from './PainelEstados'
import type { Tema } from './painel-tema'
import { assinarProjeto, projetoAtual, projetoNoServidor } from './painel-projeto'
import { buscar, pedir } from './painel-api'

/** Motivo padrão dos controles que ainda não têm para onde salvar. */
const INERTE = 'Ainda não salva — esta configuração entra numa próxima leva.'

// Nesta leva NENHUM interruptor desta tela salva: os dois motivos (obrigatória
// e sem rota) desabilitam. Por isso não há `onToggle` — guardar o estado só na
// tela era exatamente o que enganava o dono (mexia, recarregava, voltava).
function Interruptor({
  on,
  trava,
  rotulo,
}: {
  on: boolean
  /** Regra obrigatória: não pode ser desligada. */
  trava?: boolean
  rotulo: string
}) {
  return (
    <button
      disabled
      aria-pressed={on}
      aria-label={rotulo}
      title={trava ? 'Sempre ligado: não pode ser desligado.' : INERTE}
      style={{
        flex: 'none',
        width: 42,
        height: 24,
        borderRadius: 999,
        border: '1px solid ' + (on ? 'var(--gl-accent)' : 'var(--gl-hair-strong)'),
        background: on ? 'var(--gl-accent)' : 'var(--gl-surface-2)',
        position: 'relative',
        transition: 'all .2s',
        cursor: 'not-allowed',
        // Sem rota fica visivelmente apagado: o dono percebe que é ilustração,
        // não um controle que ele esqueceu de ligar.
        opacity: trava ? 1 : 0.45,
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
  /** Controle à direita. A linha de identidade da conta não tem nenhum. */
  children?: ReactNode
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

interface SessaoPayload {
  email?: string | null
  userId?: string
}

interface CriterioDaRegua {
  chave: string
  exige: string
}
interface ReguaPayload {
  regua: Record<string, boolean>
  escolhida: boolean
  criterios: CriterioDaRegua[]
}

/**
 * A régua de pronto: o cliente diz o que precisa acontecer para ele considerar
 * uma entrega entregue.
 *
 * Decisão do dono (6.1): "isso tem que ser dinâmico e o cliente escolhe nas
 * configurações do painel". Este é o único interruptor desta tela que SALVA de
 * verdade — os outros continuam desabilitados com o motivo, porque um
 * interruptor que volta sozinho no reload mente para quem mexeu nele.
 */
function ReguaDePronto() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const [dados, setDados] = useState<ReguaPayload | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    if (!projeto) {
      // Sem projeto escolhido não há régua para mostrar: a régua é POR
      // projeto, e desenhar uma "geral" seria inventar uma que não existe.
      setDados(null)
      setErro(null)
      return
    }
    try {
      setDados(await buscar<ReguaPayload>(`${ROTAS.regua}?projeto=${encodeURIComponent(projeto)}`))
      setErro(null)
    } catch {
      setErro('Não consegui ler a sua régua agora.')
    }
  }, [projeto])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const alternar = async (chave: string) => {
    if (!dados || !projeto) return
    const proxima = { ...dados.regua, [chave]: !dados.regua[chave] }
    setSalvando(true)
    try {
      const salvo = await pedir<ReguaPayload>(ROTAS.regua, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projeto, regua: proxima }),
      })
      // O estado vem da RESPOSTA, não do que a tela achou que mandou: se o
      // servidor descartar algo, a tela mostra o que ficou gravado de verdade.
      setDados({ ...dados, regua: salvo.regua, escolhida: true })
      setErro(null)
    } catch {
      setErro('Não consegui salvar. Nada mudou.')
    } finally {
      setSalvando(false)
    }
  }

  if (!projeto) {
    return (
      <Card titulo="Quando uma entrega está pronta">
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}>
          A régua é de cada projeto. Escolha um projeto no seletor do topo para ver e mudar a dele.
        </p>
      </Card>
    )
  }

  return (
    <Card flush titulo="Quando uma entrega está pronta">
      <div style={{ padding: '0 18px 12px', fontSize: 13.5, color: 'var(--gl-muted)' }}>
        Marque o que precisa acontecer para <strong>{projeto}</strong> considerar um pedido
        entregue. O que estiver desmarcado deixa de ser cobrado.
        {!dados?.escolhida && ' Hoje vale o padrão — você ainda não mexeu nisto.'}
      </div>

      {erro && (
        <div style={{ padding: '0 18px 12px', fontSize: 13.5, color: 'var(--gl-sev)' }}>{erro}</div>
      )}

      {dados?.criterios.map((c) => (
        <Linha key={c.chave} titulo={c.exige} desc="">
          <button
            type="button"
            role="switch"
            aria-checked={dados.regua[c.chave] === true}
            aria-label={c.exige}
            data-testid={`regua-${c.chave}`}
            disabled={salvando}
            onClick={() => void alternar(c.chave)}
            className={`pn-sw${dados.regua[c.chave] ? ' on' : ''}`}
          />
        </Linha>
      ))}
    </Card>
  )
}

export function TelaConfig({ tema, setTema }: { tema: Tema; setTema: (t: Tema) => void }) {
  // Identidade da conta: dado VIVO. /api/v1/auth/me já responde nesta leva.
  // Sem e-mail no payload (login que não expõe e-mail), cai num rótulo que
  // não afirma nada em vez de inventar um nome de empresa.
  const sessao = usePainelBusca<SessaoPayload>(ROTAS.sessao)
  const emailDaConta =
    sessao.estado === 'ok' && sessao.dados?.email ? sessao.dados.email : 'Sua conta'

  return (
    <>
      <Cabeca titulo="Configurações">
        Conta, avisos e aparência. Alterações valem só para você.
      </Cabeca>

      <ReguaDePronto />

      <Card flush titulo="Conta">
        <Linha titulo={emailDaConta} desc="A conta com que você entrou no painel." />
        <Linha
          titulo="GitHub conectado"
          desc="Você entrou pelo GitHub — é o que dá acesso aos seus repositórios."
        >
          <span className="pn-tag on">Ativo</span>
        </Linha>
        <Linha
          titulo="Plano"
          desc={
            <>
              Qual plano está em vigor e quantos projetos ele permite. <SeloDemo mostrar />
            </>
          }
        >
          <button className="pn-btn g sm" disabled title={INERTE}>
            Gerenciar
          </button>
        </Linha>
        <Linha
          titulo="Sócios com acesso"
          desc={
            <>
              Quem mais enxerga este painel, sem permissão de configurar. <SeloDemo mostrar />
            </>
          }
        >
          <button className="pn-btn g sm" disabled title={INERTE}>
            Convidar
          </button>
        </Linha>
      </Card>

      <Card flush titulo="Onde você quer ser avisado" sub={<SeloDemo mostrar />}>
        <Linha titulo="Telegram" desc="Decisões e entregas chegam no celular na hora">
          <Interruptor rotulo="Avisar pelo Telegram" on />
        </Linha>
        <Linha titulo="Resumo por e-mail" desc="Uma vez por semana, com o que entrou em produção">
          <Interruptor rotulo="Resumo semanal por e-mail" on={false} />
        </Linha>
        <Linha titulo="No painel" desc="Sempre ligado: o contador de decisões pendentes">
          <Interruptor rotulo="Avisar no painel" on trava />
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
        {/* Idioma NÃO é um Chips: com uma opção só, o chip continuaria sendo um
            botão clicável que não faz nada — o mesmo defeito que esta tela está
            corrigindo. Vira informação, e volta a ser controle quando existir um
            segundo idioma. */}
        <Linha titulo="Idioma" desc="Por enquanto o painel fala só português.">
          <span className="pn-tag">Português</span>
        </Linha>
      </Card>

      <Card flush titulo="Motores conectados" sub={<SeloDemo mostrar />}>
        {DEMO.motores.map((m) => (
          <Linha key={m.nome} titulo={m.nome} desc={`${m.tipo} · ${m.nota}`}>
            <span className="pn-tag on">Conectado</span>
          </Linha>
        ))}
      </Card>
    </>
  )
}
