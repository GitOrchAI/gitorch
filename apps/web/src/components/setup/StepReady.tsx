import React, { useEffect, useState } from 'react'
import { ChevronRight, Check, Loader2, Copy, KeyRound, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { useLanguage } from '../../LanguageContext'
import { deriveProvisionStatus, type ProvisionStatus, type EngineSnapshot } from './engine-status'

interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

interface StepReadyProps {
  projects: CreatedProject[]
  apiBaseUrl: string
}

/**
 * "Ambiente nascendo" — fecho premium e HONESTO. Só afirma o que é verdade: o
 * projeto e as credenciais foram criados (o submit retornou apiKey). O
 * provisionamento (clone + motores) aparece como "ativando", não como
 * "concluído" — sem fachada. Nomes próprios do produto (Cortex/CGC/Cadence),
 * nunca tech de terceiros. Chaves/CI ficam num accordion (não gritam).
 */
export default function StepReady({ projects, apiBaseUrl }: StepReadyProps) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState<number | null>(null)

  // Provisionamento: NÃO há endpoint dedicado de status (a missão
  // `clone_and_start_engines` roda no scheduler sem rota de status — fast-follow
  // no relatório). Sinal proxy honesto: GET /api/v1/engines — motores vivos =
  // ambiente ativo. Polling curto -> estado TERMINAL (pronto ✓ / falhou + retry),
  // nunca o spinner eterno de antes (done={false} hardcoded).
  const [provision, setProvision] = useState<ProvisionStatus>('provisioning')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (provision !== 'provisioning') return
    // Teto de tentativas: em vez de girar pra sempre, cai num terminal com retry.
    if (attempt >= 8) {
      setProvision('failed')
      return
    }
    let cancelled = false
    const timer = window.setTimeout(
      () => {
        fetch(`${apiBaseUrl}/api/v1/engines`, { credentials: 'include' })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { engines?: EngineSnapshot[] } | null) => {
            if (cancelled) return
            const next = deriveProvisionStatus(data?.engines ?? null)
            if (next === 'provisioning') setAttempt((a) => a + 1)
            else setProvision(next)
          })
          .catch(() => {
            if (!cancelled) setAttempt((a) => a + 1)
          })
      },
      attempt === 0 ? 0 : 2000
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, attempt, provision])

  const retryProvision = () => {
    setProvision('provisioning')
    setAttempt(0)
  }

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
          {provision === 'ready' ? (
            <Check size={30} />
          ) : provision === 'failed' ? (
            <AlertTriangle size={30} />
          ) : (
            <Loader2 className="animate-spin" size={30} />
          )}
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
        {provision === 'ready' ? (
          <LedgerItem done label={t('setup.readyLedgerActivatingReady')} />
        ) : provision === 'failed' ? (
          <LedgerItem
            done={false}
            failed
            label={t('setup.readyLedgerActivatingFailed')}
            action={
              <button
                className="wz-btn wz-btn-ghost"
                style={{ marginTop: 8 }}
                onClick={retryProvision}
              >
                {t('setup.readyRetry')}
              </button>
            }
          />
        ) : (
          <LedgerItem
            done={false}
            label={t('setup.readyLedgerActivating')}
            sub={t('setup.readyLedgerActivatingDesc')}
          />
        )}

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

function LedgerItem({
  done,
  failed,
  label,
  sub,
  action,
}: {
  done: boolean
  failed?: boolean
  label: string
  sub?: string
  action?: React.ReactNode
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-2xl p-4"
      style={{ background: 'var(--gl-canvas)', border: '1px solid var(--gl-hair)' }}
    >
      <span style={{ flex: 'none', marginTop: 1, color: 'var(--gl-accent-ink)' }}>
        {failed ? (
          <AlertTriangle size={18} />
        ) : done ? (
          <Check size={18} />
        ) : (
          <Loader2 className="animate-spin" size={18} />
        )}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="wz-opt-title" style={{ fontSize: '0.92rem' }}>
          {label}
        </div>
        {sub && <p className="wz-opt-desc">{sub}</p>}
        {action}
      </div>
    </div>
  )
}
