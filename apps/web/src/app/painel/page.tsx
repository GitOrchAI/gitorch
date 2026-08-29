'use client'
// Painel do owner — o shell. Substitui o painel antigo do cliente. Porte de
// ui_kits/painel-owner/app.jsx do handoff GitOrch Design System.
//
// Vive dentro do escopo `.gl` (camada clara, mesmos tokens da landing) com o
// tema no wrapper via `data-theme`, persistido em localStorage. Nunca mistura
// o glass violeta/ciano do painel antigo. Copy PT-BR fixa nesta leva (o i18n
// do /painel volta numa leva seguinte).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { API_BASE_URL } from '../../lib/api'
import {
  NAV,
  TABS,
  TAB_META,
  telasDaFolha,
  tituloDaTela,
  type TelaId,
} from '../../components/painel/painel-nav'
import {
  assinarTema,
  temaAtual,
  temaNoServidor,
  definirTema,
  proximoTema,
} from '../../components/painel/painel-tema'
import {
  fetchAgentQuestions,
  type AgentQuestionView,
} from '../../components/painel/agent-questions'
import { responderDecisao } from '../../components/painel/painel-api'
import { Ad, AdMark } from '../../components/painel/PainelIcons'
import type { DecisaoView } from '../../components/painel/PainelUI'
import { TelaVisaoGeral } from '../../components/painel/TelaVisaoGeral'
import { TelaPedidos } from '../../components/painel/TelaPedidos'
import { TelaDecisoes } from '../../components/painel/TelaDecisoes'
import { TelaEntregas } from '../../components/painel/TelaEntregas'
import { TelaCustos } from '../../components/painel/TelaCustos'
import { TelaProjetos } from '../../components/painel/TelaProjetos'
import { TelaRegras } from '../../components/painel/TelaRegras'
import { TelaHistorico } from '../../components/painel/TelaHistorico'
import { TelaConfig } from '../../components/painel/TelaConfig'

function tempoRelativo(iso: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} dia(s)`
}

// AgentQuestionView (rota que já existe) → o que a tela de decisões desenha.
// Campos que a dúvida não carrega (papel, número do pedido) ficam de fora —
// nunca inventados. `op` mantém {label, value}: o painel ENVIA o `value` (o
// que o agente entende), igual ao Telegram — mandar o label quebraria o
// mapeamento resposta→configuração do projeto.
function paraDecisao(q: AgentQuestionView): DecisaoView {
  return {
    id: q.id,
    q: q.text,
    ctx: q.context ?? undefined,
    agente: 'Um agente',
    quando: tempoRelativo(q.createdAt),
    op: q.options.map((o) => ({ label: o.label, value: o.value })),
    st: q.status === 'answered' ? 'respondida' : 'pendente',
    resposta: q.answer ?? undefined,
  }
}

export default function PainelOwner() {
  // `null` = ainda checando (não pisca a tela de conectar para quem já está
  // logado); `false` = não logado; `true` = painel.
  const [autenticado, setAutenticado] = useState<boolean | null>(null)
  const [checkFalhou, setCheckFalhou] = useState(false)

  const [tela, setTela] = useState<TelaId>('visao')
  // Tema por store externa (useSyncExternalStore): o server renderiza 'light'
  // e o client corrige na hidratação, sem effect de setState. O wrapper leva
  // suppressHydrationWarning porque só o atributo data-theme pode divergir.
  const tema = useSyncExternalStore(assinarTema, temaAtual, temaNoServidor)
  const setTema = definirTema
  const [sheet, setSheet] = useState(false)
  const [foco, setFoco] = useState<string | null>(null)

  const [decisoes, setDecisoes] = useState<DecisaoView[]>([])
  const [avisoDecisao, setAvisoDecisao] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    fetch(`${API_BASE_URL}/api/v1/auth/me`, { credentials: 'include' })
      .then((res) => {
        if (vivo) setAutenticado(res.ok)
      })
      .catch(() => {
        if (vivo) {
          setAutenticado(false)
          setCheckFalhou(true)
        }
      })
    return () => {
      vivo = false
    }
  }, [])

  useEffect(() => {
    if (!autenticado) return
    let vivo = true
    fetchAgentQuestions(API_BASE_URL).then((qs) => {
      if (vivo) setDecisoes(qs.map(paraDecisao))
    })
    return () => {
      vivo = false
    }
  }, [autenticado])

  const pendentes = useMemo(() => decisoes.filter((d) => d.st === 'pendente'), [decisoes])

  const ir = useCallback((id: TelaId) => {
    setTela(id)
    setSheet(false)
    if (typeof window !== 'undefined') window.scrollTo(0, 0)
  }, [])

  // Responder: chama a rota real; 409 = já respondida pelo Telegram (mostra a
  // resposta que existe em vez de sumir com o clique).
  const responder = useCallback(async (id: string, resposta: string) => {
    setAvisoDecisao(null)
    const r = await responderDecisao(id, resposta)
    if (r.ok) {
      setDecisoes((ds) =>
        ds.map((d) => (d.id === id ? { ...d, st: 'respondida', resposta: r.resposta } : d))
      )
      return
    }
    if (r.jaRespondida) {
      const ja = r.jaRespondida
      setDecisoes((ds) =>
        ds.map((d) => (d.id === id ? { ...d, st: 'respondida', resposta: ja } : d))
      )
    }
    setAvisoDecisao(r.erro)
  }, [])

  if (autenticado === null) {
    return (
      <div className="gl" data-theme={tema} suppressHydrationWarning>
        <div className="pn-scroll" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--gl-faint)' }}>Verificando sessão…</p>
        </div>
      </div>
    )
  }

  if (!autenticado) {
    return (
      <div className="gl" data-theme={tema} suppressHydrationWarning>
        <div
          className="pn-scroll"
          style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
        >
          <div className="pn-card pn-pad" style={{ maxWidth: 420 }}>
            <span className="pn-mark" style={{ margin: '0 auto 14px' }}>
              <AdMark />
            </span>
            <h1
              style={{ fontSize: 22, fontWeight: 600, margin: '0 0 8px', letterSpacing: '-.03em' }}
            >
              Conecte sua conta
            </h1>
            <p style={{ color: 'var(--gl-muted)', margin: '0 0 20px' }}>
              {checkFalhou
                ? 'Não consegui confirmar sua sessão agora. Tente conectar de novo.'
                : 'Ligue seu GitHub para ver o ritmo dos seus pedidos, as decisões e as entregas.'}
            </p>
            <Link href="/setup" className="pn-btn a" style={{ textDecoration: 'none' }}>
              Conectar
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const renderTela = (id: TelaId) => {
    switch (id) {
      case 'visao':
        return <TelaVisaoGeral ir={ir} decisoesPendentes={pendentes} responder={responder} />
      case 'pedidos':
        return <TelaPedidos />
      case 'decisoes':
        return (
          <TelaDecisoes
            decisoes={decisoes}
            responder={responder}
            aviso={avisoDecisao}
            foco={foco}
            setFoco={setFoco}
          />
        )
      case 'entregas':
        return <TelaEntregas />
      case 'custos':
        return <TelaCustos />
      case 'projetos':
        return <TelaProjetos />
      case 'regras':
        return <TelaRegras />
      case 'historico':
        return <TelaHistorico />
      case 'config':
        return <TelaConfig tema={tema} setTema={setTema} />
    }
  }

  return (
    <div className="gl" data-theme={tema} suppressHydrationWarning>
      <div className="ad">
        <aside className="pn-side">
          <div className="pn-side-brand">
            <span className="pn-mark">
              <AdMark />
            </span>
            GitOrch
          </div>
          <nav aria-label="Seções do painel">
            {NAV.map((s) => (
              <div key={s.g}>
                <div className="pn-grp">{s.g}</div>
                {s.itens.map((i) => (
                  <button
                    key={i.id}
                    className="pn-nav"
                    aria-current={tela === i.id ? 'page' : undefined}
                    onClick={() => ir(i.id)}
                  >
                    <Ad n={i.i} s={17} />
                    {i.l}
                    {i.badge && pendentes.length > 0 ? (
                      <span className="b num">{pendentes.length}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <div className="pn-main">
          <header className="pn-top">
            <span className="pn-brand">
              <span className="pn-mark">
                <AdMark />
              </span>
              GitOrch
            </span>
            <span className="pn-crumb">
              Painel / <b>{tituloDaTela(tela)}</b>
            </span>
            <span className="pn-sp" />
            <button
              className="pn-ico"
              onClick={() => setTema(proximoTema(tema))}
              aria-label="Alternar tema claro e escuro"
              title="Tema"
            >
              <Ad n={tema === 'dark' ? 'sun' : 'moon'} s={16} />
            </button>
            <button
              className="pn-ico"
              onClick={() => ir('decisoes')}
              aria-label="Decisões pendentes"
              style={{ position: 'relative' }}
            >
              <Ad n="bell" s={16} />
              {pendentes.length > 0 && <span className="c num">{pendentes.length}</span>}
            </button>
            <button className="pn-btn" onClick={() => ir('pedidos')}>
              <Ad n="plus" s={15} />
              Pedir
            </button>
          </header>

          <div className="pn-scroll">{renderTela(tela)}</div>
        </div>

        <nav className="pn-tabs" role="tablist">
          {TABS.map((id) => {
            const meta = TAB_META[id]
            const sel = id === 'mais' ? sheet : tela === id && !sheet
            return (
              <button
                key={id}
                role="tab"
                aria-selected={sel}
                className="pn-tab"
                onClick={() => (id === 'mais' ? setSheet(true) : ir(id as TelaId))}
              >
                <Ad n={meta.i} s={19} />
                {meta.l}
                {id === 'decisoes' && pendentes.length > 0 ? (
                  <span className="b num">{pendentes.length}</span>
                ) : null}
              </button>
            )
          })}
        </nav>

        {sheet && (
          <div className="pn-sheet" onClick={() => setSheet(false)}>
            <div className="pn-sheet-b" onClick={(e) => e.stopPropagation()}>
              <div style={{ padding: '10px 18px 14px' }}>
                <p className="pn-eyebrow">Mais</p>
              </div>
              {telasDaFolha().map((i) => (
                <button key={i.id} className="pn-row" onClick={() => ir(i.id)}>
                  <Ad n={i.i} s={18} style={{ color: 'var(--gl-muted)', flex: 'none' }} />
                  <span className="pn-grow pn-rt">{i.l}</span>
                  <Ad n="chev" s={15} style={{ color: 'var(--gl-faint)', flex: 'none' }} />
                </button>
              ))}
              <button
                className="pn-row"
                onClick={() => {
                  setTema(proximoTema(tema))
                  setSheet(false)
                }}
              >
                <Ad
                  n={tema === 'dark' ? 'sun' : 'moon'}
                  s={18}
                  style={{ color: 'var(--gl-muted)', flex: 'none' }}
                />
                <span className="pn-grow pn-rt">Tema {tema === 'dark' ? 'claro' : 'escuro'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
