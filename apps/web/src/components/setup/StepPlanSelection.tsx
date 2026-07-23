import React from 'react'
import { ChevronRight, ShieldCheck, BadgeCheck } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

interface StepPlanSelectionProps {
  plan: string
  setPlan: (plan: string) => void
  // Cliente chegou da landing já com um plano pago (?plan=solo/pro/team): o
  // passo vira CONFIRMAÇÃO da escolha (pode ajustar), não uma re-escolha do
  // zero — funil valor-primeiro, trata quem já decidiu como quem já decidiu.
  entryPaidIntent?: boolean
  onNext: () => void
  onBack: () => void
}

export default function StepPlanSelection({
  plan,
  setPlan,
  entryPaidIntent,
  onNext,
  onBack,
}: StepPlanSelectionProps) {
  const { t } = useLanguage()
  const isPro = plan !== 'free'

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.planTitle')}</h2>
      <p className="wz-sub">{t('setup.planDesc')}</p>

      {entryPaidIntent && (
        <div
          className="mb-4 rounded-xl px-4 py-3"
          style={{
            background: 'var(--gl-accent-soft)',
            border: '1px solid var(--gl-hair)',
            color: 'var(--gl-accent-ink)',
            fontSize: '0.85rem',
            fontWeight: 500,
          }}
        >
          {t('setup.planIntent')}
        </div>
      )}

      <div className="wz-body grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Free */}
        <button
          type="button"
          onClick={() => setPlan('free')}
          className={`wz-opt${!isPro ? ' is-selected' : ''}`}
          style={{ flexDirection: 'column', alignItems: 'stretch', padding: '22px 20px' }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span
              className="wz-opt-title flex items-center gap-1.5"
              style={{ fontSize: '1.05rem' }}
            >
              <ShieldCheck size={18} style={{ color: 'var(--gl-accent-ink)' }} />{' '}
              {t('setup.planFreeName')}
            </span>
            <span
              style={{
                fontSize: '0.62rem',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--gl-surface-2)',
                color: 'var(--gl-muted)',
              }}
            >
              {t('setup.planFreeTag')}
            </span>
          </div>
          <div
            style={{
              fontSize: '1.9rem',
              fontWeight: 800,
              marginBottom: 12,
              color: 'var(--gl-ink)',
            }}
          >
            $0
          </div>
          <p className="wz-opt-desc" style={{ marginBottom: 14 }}>
            {t('setup.planFreeDesc')}
          </p>
          <ul
            className="mt-auto space-y-1.5"
            style={{ fontSize: '0.72rem', color: 'var(--gl-muted)' }}
          >
            <li>✓ {t('setup.planFreeF1')}</li>
            <li>✓ {t('setup.planFreeF2')}</li>
            <li>✓ {t('setup.planFreeF3')}</li>
          </ul>
        </button>

        {/* Cloud Pro */}
        <button
          type="button"
          onClick={() => setPlan('pro')}
          className={`wz-opt${isPro ? ' is-selected' : ''}`}
          style={{
            flexDirection: 'column',
            alignItems: 'stretch',
            padding: '22px 20px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              background: 'var(--gl-accent)',
              // Mesma tinta fixa do badge "Recomendado" da landing (.gl-plan-badge):
              // no tema escuro --gl-accent vira verde claro, e texto branco perderia
              // contraste ali — tinta escura funciona nos dois temas (ver page.tsx).
              color: '#08090b',
              fontSize: '0.58rem',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '3px 12px',
              borderBottomLeftRadius: 12,
            }}
          >
            {t('setup.planPopular')}
          </span>
          <div className="mb-3 flex items-center justify-between">
            <span
              className="flex items-center gap-1.5"
              style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--gl-accent-ink)' }}
            >
              <BadgeCheck size={18} /> {t('setup.planProName')}
            </span>
            <span
              style={{
                fontSize: '0.62rem',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--gl-accent-soft)',
                color: 'var(--gl-accent-ink)',
              }}
            >
              {t('setup.planProTag')}
            </span>
          </div>
          <div
            style={{
              fontSize: '1.9rem',
              fontWeight: 800,
              marginBottom: 12,
              color: 'var(--gl-ink)',
            }}
          >
            $19
            <span style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--gl-muted)' }}>
              {t('setup.planProPer')}
            </span>
          </div>
          <p className="wz-opt-desc" style={{ marginBottom: 14 }}>
            {t('setup.planProDesc')}
          </p>
          <ul
            className="mt-auto space-y-1.5"
            style={{ fontSize: '0.72rem', color: 'var(--gl-muted)' }}
          >
            <li>✓ {t('setup.planProF1')}</li>
            <li>✓ {t('setup.planProF2')}</li>
            <li>✓ {t('setup.planProF3')}</li>
            <li>✓ {t('setup.planProF4')}</li>
          </ul>
        </button>
      </div>

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button onClick={onNext} className="wz-btn wz-btn-primary">
          {t('setup.next')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
