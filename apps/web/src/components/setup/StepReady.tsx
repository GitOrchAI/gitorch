import React, { useState } from 'react'
import { ChevronRight, Check, Loader2, Copy, KeyRound } from 'lucide-react'
import Link from 'next/link'
import { useLanguage } from '../../LanguageContext'

interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

interface StepReadyProps {
  projects: CreatedProject[]
}

/**
 * "Ambiente nascendo" — fecho premium e HONESTO. Só afirma o que é verdade: o
 * projeto e as credenciais foram criados (o submit retornou apiKey). O
 * provisionamento (clone + motores) aparece como "ativando", não como
 * "concluído" — sem fachada. Nomes próprios do produto (Cortex/CGC/Cadence),
 * nunca tech de terceiros. Chaves/CI ficam num accordion (não gritam).
 */
export default function StepReady({ projects }: StepReadyProps) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState<number | null>(null)

  const copy = (key: string, idx: number) => {
    navigator.clipboard?.writeText(key).then(
      () => {
        setCopied(idx)
        window.setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1800)
      },
      () => undefined
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="mb-5 flex flex-col items-center text-center">
        <div
          className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
          style={{ background: 'var(--gl-accent-soft)', color: 'var(--gl-accent-ink)' }}
        >
          <Loader2 className="animate-spin" size={30} />
        </div>
        <h2 className="wz-h" style={{ marginBottom: 8 }}>
          {t('setup.readyTitle')}
        </h2>
        <p className="wz-sub" style={{ marginBottom: 0, maxWidth: '30rem' }}>
          {t('setup.readyDesc')}
        </p>
      </div>

      <div className="wz-body space-y-3 overflow-y-auto" style={{ maxHeight: '15rem' }}>
        {/* Ledger honesto: feito ✓ vs ativando */}
        <LedgerItem
          done
          label={t('setup.readyLedgerRepo')}
          sub={projects.map((p) => p.wingId).join(', ')}
        />
        <LedgerItem done label={t('setup.readyLedgerEngines')} />
        <LedgerItem
          done={false}
          label={t('setup.readyLedgerActivating')}
          sub={t('setup.readyLedgerActivatingDesc')}
        />

        {/* Chaves + CI: rebaixadas a um accordion */}
        <details
          className="rounded-2xl"
          style={{ background: 'var(--gl-canvas)', border: '1px solid var(--gl-hair)' }}
        >
          <summary
            className="wz-opt-title flex cursor-pointer items-center gap-2"
            style={{ fontSize: '0.9rem', padding: '14px 16px', listStyle: 'none' }}
          >
            <KeyRound size={16} style={{ color: 'var(--gl-accent-ink)' }} /> {t('setup.readyKeys')}
          </summary>
          <div className="space-y-3 px-4 pb-4">
            <p className="wz-opt-desc">{t('setup.readyKeysHint')}</p>
            {projects.map((proj, idx) => (
              <div
                key={proj.id}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                style={{ background: 'var(--gl-surface-2)', border: '1px solid var(--gl-hair)' }}
              >
                <span
                  className="select-all truncate"
                  style={{
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: '0.74rem',
                    color: 'var(--gl-accent-ink)',
                  }}
                >
                  {proj.apiKey}
                </span>
                <button
                  onClick={() => copy(proj.apiKey, idx)}
                  style={{ color: 'var(--gl-muted)', flex: 'none' }}
                >
                  {copied === idx ? (
                    <Check size={14} style={{ color: 'var(--gl-accent-ink)' }} />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>
            ))}
          </div>
        </details>
      </div>

      <div className="wz-actions" style={{ justifyContent: 'center' }}>
        <Link href="/painel" className="wz-btn wz-btn-primary">
          {t('setup.readyGoPanel')} <ChevronRight size={18} />
        </Link>
      </div>
    </div>
  )
}

function LedgerItem({ done, label, sub }: { done: boolean; label: string; sub?: string }) {
  return (
    <div
      className="flex items-start gap-3 rounded-2xl p-4"
      style={{ background: 'var(--gl-canvas)', border: '1px solid var(--gl-hair)' }}
    >
      <span style={{ flex: 'none', marginTop: 1, color: 'var(--gl-accent-ink)' }}>
        {done ? <Check size={18} /> : <Loader2 className="animate-spin" size={18} />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="wz-opt-title" style={{ fontSize: '0.92rem' }}>
          {label}
        </div>
        {sub && <p className="wz-opt-desc">{sub}</p>}
      </div>
    </div>
  )
}
