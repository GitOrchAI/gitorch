import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import { API_BASE_URL } from '../../lib/api'

interface StepTermsProps {
  onAccept: () => void
}

export default function StepTerms({ onAccept }: StepTermsProps) {
  const { t } = useLanguage()
  const [accepted, setAccepted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Aceitar os termos é o gatilho que faz o ambiente isolado do cliente NASCER
  // no backend (passo 3 do ciclo de vida). Só avança quando o ambiente foi
  // criado; se falhar, mantém a pessoa no passo com um aviso, sem seguir.
  const handleAccept = async () => {
    if (!accepted || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/setup/environment`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error(String(res.status))
      onAccept()
    } catch {
      setError(t('setup.termsEnvError'))
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.termsTitle')}</h2>
      <p className="wz-sub">{t('setup.termsDesc')}</p>

      <div
        className="wz-body overflow-y-auto"
        style={{
          maxHeight: '11rem',
          background: 'var(--gl-canvas)',
          border: '1px solid var(--gl-hair)',
          borderRadius: '14px',
          padding: '18px 20px',
          fontSize: '0.86rem',
          color: 'var(--gl-muted)',
          lineHeight: 1.6,
        }}
      >
        {[
          [t('setup.terms1Title'), t('setup.terms1Body')],
          [t('setup.terms2Title'), t('setup.terms2Body')],
          [t('setup.terms3Title'), t('setup.terms3Body')],
        ].map(([title, body]) => (
          <div key={title} className="mb-4 last:mb-0">
            <h4 style={{ fontWeight: 600, color: 'var(--gl-ink)', marginBottom: '4px' }}>
              {title}
            </h4>
            <p>{body}</p>
          </div>
        ))}
      </div>

      <label className="mt-6 flex cursor-pointer select-none items-center gap-3">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: 'var(--gl-accent)' }}
        />
        <span style={{ fontSize: '0.9rem', color: 'var(--gl-ink)' }}>{t('setup.termsAccept')}</span>
      </label>

      {error && (
        <p className="mt-3" style={{ fontSize: '0.85rem', color: 'var(--gl-sev)' }}>
          {error}
        </p>
      )}

      <div className="wz-actions">
        <span />
        <button
          onClick={handleAccept}
          disabled={!accepted || loading}
          className="wz-btn wz-btn-primary"
        >
          {loading ? t('setup.termsAccepting') : t('setup.termsAcceptBtn')}{' '}
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
