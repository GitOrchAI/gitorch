import React, { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Check, Loader2, Copy, KeyRound, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { useLanguage } from '../../LanguageContext'
import { isProvisionTerminal, parseSetupStatus, type ProvisionSnapshot } from './engine-status'

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

// Cadência do acompanhamento. 5s x 60 = 5 minutos de polling: o scheduler só
// processa a missão de setup a cada tick de 60s, então uma janela curta demais
// gritaria "falhou" apenas porque a fila ainda não tinha chegado nela. 12 req/min
// também cabem com folga no limite da rota de status (60/min).
const POLL_INTERVAL_MS = 5000
const MAX_ATTEMPTS = 60

/**
 * "Ambiente nascendo" — fecho premium e HONESTO. O provisionamento mostrado aqui
 * é o REAL: GET /api/v1/setup/status devolve o estado da missão
 * `clone_and_start_engines` no banco (pending -> running -> completed/failed,
 * processada pelo scheduler). Nada de ✓ verde antes de 'completed'; a falha
 * aparece com a CAUSA que o scheduler gravou; a retentativa reenfileira a missão
 * de verdade. Nomes próprios do produto (Cortex/CGC/Cadence), nunca tech de
 * terceiros. Chaves/CI ficam num accordion (não gritam).
 */
export default function StepReady({ projects, apiBaseUrl }: StepReadyProps) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState<number | null>(null)

  const [provision, setProvision] = useState<ProvisionSnapshot>({ status: 'unknown', error: null })
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)

  // Escopo do status: os projetos criados NESTE submit. Sem isto, um projeto
  // antigo com missão falha contaminaria a leitura do que acabou de ser pedido.
  const projectIds = useMemo(() => projects.map((p) => p.id).join(','), [projects])

  const done = isProvisionTerminal(provision.status)
  // Teto de tentativas: em vez de girar pra sempre, para de bater e oferece
  // "Atualizar". O provisionamento SEGUE em segundo plano — isso é verdade, não
  // uma falha, e por isso não viramos o card em erro aqui.
  const stalled = !done && attempt >= MAX_ATTEMPTS

  useEffect(() => {
    if (done || stalled) return
    let cancelled = false
    const timer = window.setTimeout(
      () => {
        const query = projectIds ? `?projects=${encodeURIComponent(projectIds)}` : ''
        fetch(`${apiBaseUrl}/api/v1/setup/status${query}`, { credentials: 'include' })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: unknown) => {
            if (cancelled) return
            const next = parseSetupStatus(data)
            setProvision(next)
            if (!isProvisionTerminal(next.status)) setAttempt((a) => a + 1)
          })
          .catch(() => {
            if (!cancelled) setAttempt((a) => a + 1)
          })
      },
      attempt === 0 ? 0 : POLL_INTERVAL_MS
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, attempt, done, stalled, projectIds])

  // Volta a perguntar ao servidor (que é a fonte da verdade) desde o zero.
  const resumePolling = () => {
    setProvision({ status: 'unknown', error: null })
    setAttempt(0)
  }

  // Retentativa REAL: o backend reenfileira a missão de provisionamento (missão
  // nova, mesmo payload) e voltamos a acompanhar. Se a retentativa não pegar, o
  // próximo poll mostra a falha de novo — sem fachada.
  const retryProvision = () => {
    setRetrying(true)
    fetch(`${apiBaseUrl}/api/v1/setup/retry`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: projects.map((p) => p.id) }),
    })
      .catch(() => undefined)
      .finally(() => {
        setRetrying(false)
        resumePolling()
      })
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
          {provision.status === 'completed' ? (
            <Check size={30} />
          ) : provision.status === 'failed' ? (
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
        {/* Ledger honesto: feito ✓ vs provisionando (o que o banco diz, não o que soa bem) */}
        <LedgerItem
          done
          label={t('setup.readyLedgerRepo')}
          sub={projects.map((p) => p.wingId).join(', ')}
        />
        <LedgerItem done label={t('setup.readyLedgerEngines')} />
        {provision.status === 'completed' ? (
          <LedgerItem done label={t('setup.readyLedgerActivatingReady')} />
        ) : provision.status === 'failed' ? (
          <LedgerItem
            done={false}
            failed
            label={t('setup.readyLedgerActivatingFailed')}
            // A causa REAL da missão quando o backend a registrou; senão, um
            // texto localizado — nunca um "deu tudo certo" mentiroso.
            sub={provision.error ?? t('setup.readyLedgerActivatingFailedDesc')}
            action={
              <button
                className="wz-btn wz-btn-ghost"
                style={{ marginTop: 8 }}
                onClick={retryProvision}
                disabled={retrying}
              >
                {t('setup.readyRetry')}
              </button>
            }
          />
        ) : stalled ? (
          <LedgerItem
            done={false}
            label={t('setup.readyLedgerActivating')}
            sub={t('setup.readyLedgerActivatingSlow')}
            action={
              <button
                className="wz-btn wz-btn-ghost"
                style={{ marginTop: 8 }}
                onClick={resumePolling}
              >
                {t('setup.readyRefresh')}
              </button>
            }
          />
        ) : (
          <LedgerItem
            done={false}
            label={t('setup.readyLedgerActivating')}
            sub={
              provision.status === 'pending'
                ? t('setup.readyLedgerActivatingQueued')
                : provision.status === 'running'
                  ? t('setup.readyLedgerActivatingRunning')
                  : t('setup.readyLedgerActivatingDesc')
            }
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
