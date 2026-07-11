import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Check, ExternalLink, Loader2, Cpu, Sparkles, Terminal } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

interface StepConnectEngineProps {
  apiBaseUrl: string
  selectedEngines: string[]
  onNext: () => void
  onBack: () => void
}

const ENGINES = [
  { id: 'claude-code', runtime: 'claude', name: 'Claude Code', Icon: Cpu },
  { id: 'codex', runtime: 'codex', name: 'Codex', Icon: Sparkles },
  { id: 'antigravity', runtime: 'antigravity', name: 'Antigravity', Icon: Terminal },
] as const

type LoginState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'url_ready'; url: string; code?: string }
  | { phase: 'connected'; models?: number; quota?: number | null }
  | { phase: 'error'; message: string }

export default function StepConnectEngine({
  apiBaseUrl,
  selectedEngines,
  onNext,
  onBack,
}: StepConnectEngineProps) {
  const { t } = useLanguage()
  const cards = useMemo(
    () => ENGINES.filter((e) => selectedEngines.includes(e.id)),
    [selectedEngines]
  )

  const [states, setStates] = useState<Record<string, LoginState>>({})
  const [pastedCode, setPastedCode] = useState<Record<string, string>>({})
  const loginIds = useRef<Record<string, string>>({})
  const sources = useRef<Record<string, EventSource>>({})

  // Estado real do servidor: motores já conectados aparecem como conectados.
  useEffect(() => {
    let cancelled = false
    fetch(`${apiBaseUrl}/api/v1/engines`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            engines?: Array<{
              runtime: string
              status: string
              models?: string[]
              quotaRemaining?: number | null
            }>
          } | null
        ) => {
          if (cancelled || !data?.engines) return
          const connected: Record<string, LoginState> = {}
          for (const card of ENGINES) {
            const eng = data.engines.find(
              (e) => e.runtime === card.runtime && e.status === 'connected'
            )
            if (eng) {
              connected[card.id] = {
                phase: 'connected',
                models: Array.isArray(eng.models) ? eng.models.length : undefined,
                quota: eng.quotaRemaining ?? null,
              }
            }
          }
          setStates((prev) => ({ ...connected, ...prev }))
        }
      )
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl])

  // Fecha os EventSource abertos ao desmontar (troca de passo do wizard).
  useEffect(() => {
    return () => {
      for (const src of Object.values(sources.current)) src.close()
    }
  }, [])

  const connect = async (id: string, runtime: string) => {
    // Fecha qualquer stream anterior ainda aberto para este motor — evita
    // vazar a conexão se "Conectar" for acionado mais de uma vez em sequência
    // (ex.: duplo clique antes do re-render esconder o botão).
    const prevSource = sources.current[id]
    if (prevSource) {
      prevSource.close()
      delete sources.current[id]
    }
    setStates((s) => ({ ...s, [id]: { phase: 'starting' } }))
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/engines/${runtime}/login/start`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setStates((s) => ({
          ...s,
          [id]: { phase: 'error', message: data?.error || t('setup.connectError') },
        }))
        return
      }
      const { loginId } = (await res.json()) as { loginId: string }
      loginIds.current[id] = loginId

      const src = new EventSource(`${apiBaseUrl}/api/v1/engines/login/${loginId}/stream`, {
        withCredentials: true,
      } as EventSourceInit)
      sources.current[id] = src
      src.addEventListener('state', (evt) => {
        const state = JSON.parse((evt as MessageEvent).data) as LoginState
        setStates((s) => ({ ...s, [id]: state }))
        if (state.phase === 'connected' || state.phase === 'error') {
          src.close()
          delete sources.current[id]
        }
      })
      src.onerror = () => {
        setStates((s) => ({ ...s, [id]: { phase: 'error', message: t('setup.connectError') } }))
        src.close()
        delete sources.current[id]
      }
    } catch {
      setStates((s) => ({ ...s, [id]: { phase: 'error', message: t('setup.connectError') } }))
    }
  }

  const submitCode = async (id: string) => {
    const loginId = loginIds.current[id]
    const code = (pastedCode[id] ?? '').trim()
    if (!loginId || !code) return
    // Falha aqui (rede/500) TEM que virar estado de erro visível: engolir a
    // falha deixava a pessoa presa em "aguardando aprovação" pra sempre, sem
    // saber que o código nunca chegou. O bloco de erro já oferece o retry.
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/engines/login/${loginId}/code`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      setStates((s) => ({ ...s, [id]: { phase: 'error', message: t('setup.connectError') } }))
    }
  }

  const anyConnected = cards.some((c) => states[c.id]?.phase === 'connected')

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.connectTitle')}</h2>
      <p className="wz-sub">{t('setup.connectDesc')}</p>

      <div className="wz-body space-y-4 overflow-y-auto" style={{ maxHeight: '18rem' }}>
        {cards.map(({ id, runtime, name, Icon }) => {
          const state: LoginState = states[id] ?? { phase: 'idle' }
          const isConnected = state.phase === 'connected'
          return (
            <div
              key={id}
              className="rounded-2xl p-5"
              style={{
                background: 'var(--gl-canvas)',
                border: `1px solid ${isConnected ? 'var(--gl-accent)' : 'var(--gl-hair)'}`,
                boxShadow: isConnected ? '0 0 0 3px var(--gl-accent-soft)' : 'none',
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="wz-opt-title flex items-center gap-2">
                  <Icon size={18} style={{ color: 'var(--gl-accent-ink)' }} /> {name}
                </span>
                {isConnected && (
                  <span className="wz-ok">
                    <Check size={16} /> {t('setup.connectedLabel')}
                  </span>
                )}
              </div>

              {/* Motor VIVO: mostra que respondeu de verdade (nº de modelos + quota). */}
              {state.phase === 'connected' && (state.models != null || state.quota != null) && (
                <p className="wz-opt-desc" style={{ fontSize: '0.78rem' }}>
                  {state.models != null && `${state.models} ${t('setup.connectModelsLabel')}`}
                  {state.models != null && state.quota != null && ' · '}
                  {state.quota != null && `${t('setup.connectQuotaLabel')}: ${state.quota}`}
                </p>
              )}

              {state.phase === 'idle' && (
                <button className="wz-btn wz-btn-primary" onClick={() => connect(id, runtime)}>
                  {t('setup.connectBtn')}
                </button>
              )}

              {state.phase === 'starting' && (
                <span className="wz-opt-desc inline-flex items-center gap-2">
                  <Loader2 className="animate-spin" size={16} /> {t('setup.connecting')}
                </span>
              )}

              {state.phase === 'url_ready' && (
                <div className="space-y-3">
                  <a
                    className="wz-btn wz-btn-primary inline-flex items-center gap-2"
                    href={state.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('setup.connectOpenLink')} <ExternalLink size={14} />
                  </a>
                  {state.code && (
                    <div className="wz-cmd">
                      <code>{state.code}</code>
                    </div>
                  )}
                  {!state.code && (
                    <div className="flex items-center gap-2">
                      <input
                        className="wz-field"
                        type="text"
                        placeholder={t('setup.connectPasteCodePlaceholder')}
                        value={pastedCode[id] ?? ''}
                        onChange={(e) => setPastedCode((p) => ({ ...p, [id]: e.target.value }))}
                      />
                      <button
                        className="wz-btn wz-btn-primary"
                        style={{ flex: 'none' }}
                        disabled={!(pastedCode[id] ?? '').trim()}
                        onClick={() => submitCode(id)}
                      >
                        {t('setup.connectSubmitCode')}
                      </button>
                    </div>
                  )}
                  <p className="wz-opt-desc">{t('setup.connectWaitingApproval')}</p>
                </div>
              )}

              {state.phase === 'error' && (
                <div className="space-y-2">
                  <p className="wz-err">{state.message}</p>
                  <button className="wz-btn wz-btn-primary" onClick={() => connect(id, runtime)}>
                    {t('setup.connectBtn')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!anyConnected && (
        <p className="wz-opt-desc" style={{ marginTop: 12 }}>
          {t('setup.connectGate')}
        </p>
      )}

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button onClick={onNext} disabled={!anyConnected} className="wz-btn wz-btn-primary">
          {t('setup.next')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
