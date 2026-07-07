import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

interface StepTermsProps {
  onAccept: () => void
}

export default function StepTerms({ onAccept }: StepTermsProps) {
  const { t } = useLanguage()
  const [accepted, setAccepted] = useState(false)

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

      <div className="wz-actions">
        <span />
        <button onClick={onAccept} disabled={!accepted} className="wz-btn wz-btn-primary">
          {t('setup.termsAcceptBtn')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
