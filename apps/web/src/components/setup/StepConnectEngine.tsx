import React, { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Check, Copy, Loader2, Cpu, Sparkles, Terminal } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

interface StepConnectEngineProps {
  apiBaseUrl: string
  selectedEngines: string[]
  onNext: () => void
  onBack: () => void
}

// Metadados por motor. `id` é o vocabulário do wizard (o backend resolve
// claude-code→claude via resolveEngineId). `runtime` é o id retornado por
// GET /api/v1/engines (já resolvido), usado para casar o status. Comando é
// shell literal (não traduzido); o "how" é i18n.
const ENGINES = [
  {
    id: 'claude-code',
    runtime: 'claude',
    name: 'Claude Code',
    cmd: 'claude setup-token',
    howKey: 'setup.connectClaudeHow',
    placeholder: 'sk-ant-oat01-...',
    Icon: Cpu,
  },
  {
    id: 'codex',
    runtime: 'codex',
    name: 'Codex',
    cmd: 'codex login',
    howKey: 'setup.connectCodexHow',
    placeholder: '{ "auth_mode": "chatgpt", ... }',
    Icon: Sparkles,
  },
  {
    id: 'antigravity',
    runtime: 'antigravity',
    name: 'Antigravity',
    cmd: 'agy login',
    howKey: 'setup.connectAntigravityHow',
    placeholder: 'oauth-token...',
    Icon: Terminal,
  },
] as const

type Status = 'idle' | 'connecting' | 'connected' | 'error'

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

  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)

  // Estado real do servidor: motores já conectados aparecem como conectados
  // (o cliente pode ter conectado antes, ou reabrir o wizard).
  useEffect(() => {
    let cancelled = false
    fetch(`${apiBaseUrl}/api/v1/engines`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { engines?: Array<{ runtime: string; status: string }> } | null) => {
        if (cancelled || !data?.engines) return
        const connected: Record<string, Status> = {}
        for (const card of ENGINES) {
          if (data.engines.some((e) => e.runtime === card.runtime && e.status === 'connected')) {
            connected[card.id] = 'connected'
          }
        }
        setStatus((prev) => ({ ...connected, ...prev }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl])

  const connect = async (id: string) => {
    const token = (tokens[id] ?? '').trim()
    if (!token) return
    setStatus((s) => ({ ...s, [id]: 'connecting' }))
    setErrors((e) => ({ ...e, [id]: '' }))
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/engines/${id}/token`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        setStatus((s) => ({ ...s, [id]: 'error' }))
        setErrors((e) => ({ ...e, [id]: data?.error || t('setup.connectError') }))
        return
      }
      setStatus((s) => ({ ...s, [id]: 'connected' }))
    } catch {
      setStatus((s) => ({ ...s, [id]: 'error' }))
      setErrors((e) => ({ ...e, [id]: t('setup.connectError') }))
    }
  }

  const copy = (id: string, cmd: string) => {
    navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopied(id)
        window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
      },
      () => undefined
    )
  }

  const anyConnected = cards.some((c) => status[c.id] === 'connected')

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.connectTitle')}</h2>
      <p className="wz-sub">{t('setup.connectDesc')}</p>

      <div className="wz-body space-y-4 overflow-y-auto" style={{ maxHeight: '18rem' }}>
        {cards.map(({ id, name, cmd, howKey, placeholder, Icon }) => {
          const st: Status = status[id] ?? 'idle'
          const isConnected = st === 'connected'
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

              {!isConnected && (
                <>
                  <p className="wz-opt-desc" style={{ marginBottom: 12 }}>
                    {t(howKey)}
                  </p>
                  <div className="wz-cmd" style={{ marginBottom: 10 }}>
                    <code>{cmd}</code>
                    <button className="wz-cmd-copy" onClick={() => copy(id, cmd)}>
                      {copied === id ? (
                        t('setup.connectCopied')
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Copy size={12} /> {t('setup.connectCopy')}
                        </span>
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="wz-field"
                      type="text"
                      placeholder={placeholder}
                      value={tokens[id] ?? ''}
                      onChange={(e) => setTokens((tk) => ({ ...tk, [id]: e.target.value }))}
                    />
                    <button
                      className="wz-btn wz-btn-primary"
                      style={{ flex: 'none' }}
                      disabled={st === 'connecting' || !(tokens[id] ?? '').trim()}
                      onClick={() => connect(id)}
                    >
                      {st === 'connecting' ? (
                        <>
                          <Loader2 className="animate-spin" size={16} /> {t('setup.connecting')}
                        </>
                      ) : (
                        t('setup.connectBtn')
                      )}
                    </button>
                  </div>
                  {st === 'error' && errors[id] && <p className="wz-err">{errors[id]}</p>}
                </>
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
