import React from 'react'
import { ChevronRight, Check, Cloud, Server } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

export type HostingMode = 'cloud' | 'vm'

interface StepSelectHostingProps {
  hostingMode: HostingMode
  setHostingMode: (mode: HostingMode) => void
  onNext: () => void
  onBack: () => void
}

export default function StepSelectHosting({
  hostingMode,
  setHostingMode,
  onNext,
  onBack,
}: StepSelectHostingProps) {
  const { t } = useLanguage()

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.hostingTitle')}</h2>
      <p className="wz-sub">{t('setup.hostingDesc')}</p>

      <div className="wz-body space-y-3">
        {/* Opção 1: Nossa Nuvem */}
        <button
          type="button"
          onClick={() => setHostingMode('cloud')}
          className={`wz-opt${hostingMode === 'cloud' ? ' is-selected' : ''}`}
        >
          <div className="flex items-start gap-3">
            <Cloud
              size={22}
              style={{ color: 'var(--gl-accent-ink)', flex: 'none', marginTop: 2 }}
            />
            <div>
              <div className="flex items-center gap-2">
                <span className="wz-opt-title">{t('setup.hostingCloudTitle')}</span>
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
                  {t('setup.hostingCloudBadge')}
                </span>
              </div>
              <p className="wz-opt-desc">{t('setup.hostingCloudDesc')}</p>
            </div>
          </div>
          {hostingMode === 'cloud' && (
            <span className="wz-ok" style={{ flex: 'none' }}>
              <Check size={16} />
            </span>
          )}
        </button>

        {/* Opção 2: Minha VM / Self-Hosted */}
        <button
          type="button"
          onClick={() => setHostingMode('vm')}
          className={`wz-opt${hostingMode === 'vm' ? ' is-selected' : ''}`}
        >
          <div className="flex items-start gap-3">
            <Server
              size={22}
              style={{ color: 'var(--gl-accent-ink)', flex: 'none', marginTop: 2 }}
            />
            <div>
              <div className="flex items-center gap-2">
                <span className="wz-opt-title">{t('setup.hostingVmTitle')}</span>
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
                  {t('setup.hostingVmBadge')}
                </span>
              </div>
              <p className="wz-opt-desc">{t('setup.hostingVmDesc')}</p>
              <p
                className="mt-2 rounded px-2 py-1 inline-block"
                style={{
                  background: 'var(--gl-accent-soft)',
                  color: 'var(--gl-accent-ink)',
                  fontSize: '0.72rem',
                  fontWeight: 500,
                }}
              >
                {t('setup.hostingVmSpec')}
              </p>
              {hostingMode === 'vm' && (
                <div
                  className="mt-3 rounded-lg p-2.5"
                  style={{
                    background: 'var(--gl-accent-soft)',
                    color: 'var(--gl-accent-ink)',
                    fontSize: '0.78rem',
                  }}
                >
                  {t('setup.hostingVmNote')}
                </div>
              )}
            </div>
          </div>
          {hostingMode === 'vm' && (
            <span className="wz-ok" style={{ flex: 'none' }}>
              <Check size={16} />
            </span>
          )}
        </button>
      </div>

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button onClick={onNext} disabled={hostingMode === 'vm'} className="wz-btn wz-btn-primary">
          {hostingMode === 'vm' ? (
            t('setup.hostingVmComingSoon')
          ) : (
            <>
              {t('setup.next')} <ChevronRight size={18} />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
