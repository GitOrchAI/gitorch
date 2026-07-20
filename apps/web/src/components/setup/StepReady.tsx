import React, { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Check, Loader2, Copy, KeyRound, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { useLanguage } from '../../LanguageContext'
import { detectCountry } from '../../lib/geo'
import {
  isProvisionTerminal,
  parseSetupStatus,
  formatEngineVersions,
  type ProvisionSnapshot,
} from './engine-status'
import { isPaidPlan, startCheckout, type CreatedProject } from './submit-flow'

interface StepReadyProps {
  projects: CreatedProject[]
  apiBaseUrl: string
  plan: string
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
 * terceiros.
 *
 * ESTA É A ÚNICA TELA QUE MOSTRA A CHAVE DE API — e a única vez que ela existe em
 * texto puro (o banco guarda só o hash). Duas consequências no desenho daqui:
 *
 * 1. A chave NÃO fica mais escondida atrás de um accordion fechado. Ela aparece
 *    aberta, com o aviso de que é a única exibição.
 * 2. Todas as saídas desta tela (pagamento e painel) ficam travadas até o cliente
 *    reconhecer que guardou a chave — copiar já vale como reconhecimento. Sair
 *    daqui sem ela é perdê-la para sempre, então a saída fácil não pode ser a
 *    saída burra.
 *
 * O pagamento também mora aqui, e não no passo anterior: o plano pago vê a
 * credencial ANTES de ser levado ao Stripe (de lá o cliente cai no /painel e
 * nunca mais volta ao wizard).
 */
export default function StepReady({ projects, apiBaseUrl, plan }: StepReadyProps) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState<number | null>(null)
  // Reconhecimento explícito de que a chave foi guardada. Vive só na memória do
  // React: a chave nunca vai pra localStorage/sessionStorage (qualquer XSS leria,
  // e ela sobreviveria em disco) nem pra URL (histórico, logs e o header Referer
  // mandado ao Stripe vazariam o segredo).
  const [keySaved, setKeySaved] = useState(false)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)

  const [provision, setProvision] = useState<ProvisionSnapshot>({
    status: 'unknown',
    error: null,
    queuePosition: null,
    environmentResources: null,
  })
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
    setProvision({
      status: 'unknown',
      error: null,
      queuePosition: null,
      environmentResources: null,
    })
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

  // "Recomeçar do zero" — último recurso quando a retentativa cirúrgica
  // (mesma missão, mesmo projeto) não resolve: destrói o ambiente do cliente
  // (o clone quebrado incluso) e recarrega a página, que volta ao início do
  // wizard com um estado limpo garantido pelo servidor. Best-effort: mesmo
  // se a chamada de rede falhar, recarregar ainda ajuda.
  const [startingOver, setStartingOver] = useState(false)
  const startOver = () => {
    setStartingOver(true)
    fetch(`${apiBaseUrl}/api/v1/setup/environment/reset`, {
      method: 'POST',
      credentials: 'include',
    })
      .catch(() => undefined)
      .finally(() => {
        window.location.reload()
      })
  }

  // Copiar já É o reconhecimento (o cliente que copiou não perde nada). O checkbox
  // continua existindo como caminho alternativo: `navigator.clipboard` não existe
  // em origem não-segura, e nesse caso o copiar simplesmente não acontece.
  const copy = (key: string, idx: number) => {
    navigator.clipboard?.writeText(key).then(
      () => {
        setCopied(idx)
        setKeySaved(true)
        window.setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1800)
      },
      () => undefined
    )
  }

  const needsPayment = isPaidPlan(plan)
  const hasKeys = projects.length > 0
  // Trava as saídas enquanto a chave não foi reconhecida. Sem chave na lista
  // (não deveria acontecer — o submit falha antes disso) não há o que travar:
  // prender o cliente numa tela sem credencial seria só crueldade.
  const locked = hasKeys && !keySaved

  /**
   * Leva ao Stripe — DEPOIS da chave estar na tela e reconhecida. É o único ponto
   * do wizard que tira o cliente do app, e ele é um clique consciente, não um
   * redirect automático nas costas de quem acabou de receber uma credencial
   * irrecuperável.
   *
   * Se o checkout não abrir, ninguém fica no prejuízo: o projeto e a chave já
   * existem: o cliente vê a causa e pode tentar de novo ou ir para o painel.
   */
  const goToPayment = async () => {
    setPaying(true)
    setPayError(null)
    // Mesma detecção por IP da landing: a moeda do checkout segue a localização
    // real do cliente, não o idioma do navegador.
    const country = await detectCountry()
    const outcome = await startCheckout({ apiBaseUrl, plan, country })
    if (outcome.ok) {
      window.location.assign(outcome.url)
      return
    }
    setPayError(
      outcome.reason === 'at_capacity' ? t('setup.readyPayCapacity') : t('setup.readyPayFailed')
    )
    setPaying(false)
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

      <div className="wz-body space-y-3 overflow-y-auto" style={{ maxHeight: '18rem' }}>
        {/* A CHAVE VEM PRIMEIRO, antes do ledger — e aberta, não escondida atrás de
            um accordion fechado. Este bloco é a única vez que a credencial existe
            em texto puro em qualquer lugar do mundo; o ledger ao lado é só status
            ao vivo, que o cliente pode reler no painel quando quiser. O perecível
            fica onde o olho bate primeiro, sem depender de rolagem. */}
        {hasKeys && (
          <div
            className="rounded-2xl"
            style={{ background: 'var(--gl-canvas)', border: '1px solid var(--gl-hair)' }}
          >
            <div
              className="wz-opt-title flex items-center gap-2"
              style={{ fontSize: '0.9rem', padding: '14px 16px 8px' }}
            >
              <KeyRound size={16} style={{ color: 'var(--gl-accent-ink)' }} />{' '}
              {t('setup.readyKeys')}
            </div>
            <div className="space-y-3 px-4 pb-4">
              {/* O aviso. Sem meio-termo: não existe "ver depois". */}
              <div
                className="flex items-start gap-2 rounded-xl p-3"
                style={{ background: 'var(--gl-accent-soft)', border: '1px solid var(--gl-hair)' }}
              >
                <AlertTriangle
                  size={16}
                  style={{ color: 'var(--gl-sev)', flex: 'none', marginTop: 2 }}
                />
                <p className="wz-opt-desc" style={{ margin: 0 }}>
                  {t('setup.readyKeyOnce')}
                </p>
              </div>

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
                    aria-label={t('setup.readyKeyCopy')}
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

              {/* O reconhecimento que destrava as saídas. Copiar também marca. */}
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={keySaved}
                  onChange={(e) => setKeySaved(e.target.checked)}
                  style={{ accentColor: 'var(--gl-accent)', flex: 'none' }}
                />
                <span className="wz-opt-desc" style={{ margin: 0 }}>
                  {t('setup.readyKeySaved')}
                </span>
              </label>
            </div>
          </div>
        )}

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
              <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
                <button
                  className="wz-btn wz-btn-ghost"
                  onClick={retryProvision}
                  disabled={retrying || startingOver}
                >
                  {t('setup.readyRetry')}
                </button>
                {/* Último recurso: a retentativa cirúrgica acima reusa a MESMA
                    missão/projeto; isto destrói o ambiente inteiro e recomeça
                    o wizard do zero — para quando a retentativa não resolve. */}
                <button
                  className="wz-btn wz-btn-ghost"
                  onClick={startOver}
                  disabled={retrying || startingOver}
                >
                  {t('setup.startOver')}
                </button>
              </div>
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
                ? provision.queuePosition
                  ? t('setup.readyLedgerActivatingQueuedPosition', {
                      position: provision.queuePosition,
                    })
                  : t('setup.readyLedgerActivatingQueued')
                : provision.status === 'running'
                  ? t('setup.readyLedgerActivatingRunning')
                  : t('setup.readyLedgerActivatingDesc')
            }
          />
        )}

        {/* W1: as versões REAIS instaladas no ambiente isolado do cliente — o
            gate desta fase é ele VER isto, nunca supor. `environmentResources`
            vem de GET /setup/status (via ClientEnvironment.resourcesLock no
            backend) e só existe quando o bootstrap terminou de instalar os
            motores; até lá, o texto diz "preparando", nunca finge pronto. */}
        <div
          className="rounded-2xl p-4"
          style={{ background: 'var(--gl-canvas)', border: '1px solid var(--gl-hair)' }}
        >
          {provision.environmentResources ? (
            <>
              <div className="wz-opt-title" style={{ fontSize: '0.92rem' }}>
                {t('setup.readyResourcesTitle')}
              </div>
              <p className="wz-opt-desc" style={{ margin: 0 }}>
                {formatEngineVersions(provision.environmentResources.engines)}
              </p>
              <p className="wz-opt-desc" style={{ margin: 0 }}>
                {t('setup.readyResourcesCommit', {
                  commit: provision.environmentResources.commit,
                })}
              </p>
            </>
          ) : (
            <p className="wz-opt-desc" style={{ margin: 0 }}>
              {t('setup.readyResourcesPreparing')}
            </p>
          )}
        </div>
      </div>

      <div
        className="wz-actions"
        style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
      >
        {payError && <p className="wz-err text-center">{payError}</p>}
        {locked && (
          <p className="wz-opt-desc text-center" style={{ margin: 0 }}>
            {t('setup.readyLockedHint')}
          </p>
        )}
        <div className="flex items-center justify-center gap-3">
          {needsPayment && (
            <button
              onClick={goToPayment}
              disabled={locked || paying}
              className="wz-btn wz-btn-primary"
            >
              {paying ? (
                <>
                  <Loader2 className="animate-spin" size={18} /> {t('setup.readyPaying')}
                </>
              ) : (
                <>
                  {t('setup.readyGoPay')} <ChevronRight size={18} />
                </>
              )}
            </button>
          )}
          {locked ? (
            // Link não sabe ficar desabilitado — enquanto a chave não for
            // reconhecida, a porta do painel é um botão morto, de propósito.
            <button
              disabled
              className={needsPayment ? 'wz-btn wz-btn-ghost' : 'wz-btn wz-btn-primary'}
            >
              {t('setup.readyGoPanel')}
            </button>
          ) : (
            <Link
              href="/painel"
              className={needsPayment ? 'wz-btn wz-btn-ghost' : 'wz-btn wz-btn-primary'}
            >
              {t('setup.readyGoPanel')} <ChevronRight size={18} />
            </Link>
          )}
        </div>
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
