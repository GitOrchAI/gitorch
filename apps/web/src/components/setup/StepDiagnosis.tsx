import React, { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ChevronRight, Loader2, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import { parseDiagnosisErrorCode, setupErrorHintKey } from './setup-errors'
import { isWebglAvailable } from './graph3d-layout'
import type { RepoGraph3DNode, RepoGraph3DEdge } from './RepoGraph3D'

// react-three-fiber precisa de WebGL/`document` — `next build` (output:
// 'export') faz um passe de pré-render em Node sem nenhum dos dois.
// `ssr: false` tira o componente do bundle de servidor inteiramente; ele só
// monta no browser, depois que isWebglAvailable() (mesma guarda) já decidiu
// que dá pra tentar.
const RepoGraph3D = dynamic(() => import('./RepoGraph3D'), { ssr: false })

interface GraphExportResult {
  nodes: RepoGraph3DNode[]
  edges: RepoGraph3DEdge[]
  truncated: boolean
  aggregatedBy?: 'directory'
}

// O export do grafo (CGC) reprocessa o repo do zero na 1ª chamada: ~7-8s
// medido local, mais ainda pela rede real (Tailscale) que o dono usa — 8s
// cortava a resposta ANTES dela chegar, e caía sempre no fallback em tabela
// mesmo a rota respondendo 200 com o grafo real (a causa raiz do bug, não
// WebGL nem o grafo em si). 30s dá folga de sobra pro pior caso a frio; o
// cache no backend (DiagnosisJob.graph) faz a 2ª chamada em diante voltar
// quase instantânea, então esse teto alto só é pago uma vez por job.
const GRAPH_FETCH_TIMEOUT_MS = 30_000

interface DiagnosisFinding {
  key: 'healthy_core' | 'untested_ratio' | 'stale_prs' | 'ci_failing' | 'open_issues'
  severity: 'good' | 'warn' | 'bad'
  data: Record<string, number>
}
interface StructuralDiagnosis {
  fileCount: number
  indexedFiles: number
  largestFiles: Array<{ file: string; symbolCount: number }>
  mostCalledFunctions: Array<{ name: string; file: string; callCount: number }>
  directoryInventory: Record<string, string[]>
}
interface DiagnosisResult {
  empty?: boolean
  structural?: StructuralDiagnosis
  healthScore?: number
  findings?: DiagnosisFinding[]
}
interface DiagnosisJob {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: string | null
  result: DiagnosisResult | null
  error: string | null
}

interface StepDiagnosisProps {
  apiBaseUrl: string
  repoFullName: string
  onNext: () => void
  onBack: () => void
}

const POLL_MS = 1500

function verdictKey(score: number): string {
  if (score >= 80) return 'setup.diagVerdictGood'
  if (score >= 50) return 'setup.diagVerdictWarn'
  return 'setup.diagVerdictBad'
}

function findingCopyKey(key: DiagnosisFinding['key']): string {
  const map: Record<DiagnosisFinding['key'], string> = {
    healthy_core: 'setup.diagFindingHealthyCore',
    untested_ratio: 'setup.diagFindingUntestedRatio',
    stale_prs: 'setup.diagFindingStalePrs',
    ci_failing: 'setup.diagFindingCiFailing',
    open_issues: 'setup.diagFindingOpenIssues',
  }
  return map[key]
}

const SeverityIcon = ({ severity }: { severity: DiagnosisFinding['severity'] }) => {
  if (severity === 'good') return <CheckCircle2 size={18} className="wz-diag-ficon good" />
  if (severity === 'warn') return <AlertTriangle size={18} className="wz-diag-ficon warn" />
  return <AlertCircle size={18} className="wz-diag-ficon bad" />
}

export default function StepDiagnosis({
  apiBaseUrl,
  repoFullName,
  onNext,
  onBack,
}: StepDiagnosisProps) {
  const { t } = useLanguage()
  const [job, setJob] = useState<DiagnosisJob | null>(null)
  // Guarda só SE deu erro (booleano) — a mensagem é traduzida na renderização
  // (t() não é memoizada no contexto; usá-la dentro do efeito reiniciaria o
  // diagnóstico a cada re-render se entrasse nas deps).
  const [startFailed, setStartFailed] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  // Bump pra re-disparar o efeito (clique em "tentar de novo") — idiomático
  // no React: o efeito reage a uma mudança de dependência, nunca é chamado
  // de fora dele mesmo.
  const [attempt, setAttempt] = useState(0)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Grafo 3D (F1 — Onda 3): busca só DEPOIS do diagnóstico já ter completado
  // com código real (nunca em paralelo com o polling, nunca pra repo vazio).
  // 'unavailable' cobre TUDO que não é sucesso — rede, 5xx, timeout de 8s,
  // sem WebGL — e cai no fallback em tabela que já existe (wz-diag-details),
  // nunca bloqueia o resto do wizard.
  const [graph, setGraph] = useState<GraphExportResult | null>(null)
  const [graphState, setGraphState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  // Inicializador preguiçoso (roda 1x na primeira renderização, não num
  // efeito) — checar WebGL nunca precisa de setState dentro do efeito de
  // busca abaixo, só um early-return síncrono.
  const [webglAvailable] = useState(isWebglAvailable)

  const retry = () => {
    setStartFailed(false)
    setJob(null)
    setGraph(null)
    setGraphState('idle')
    setAttempt((a) => a + 1)
  }

  useEffect(() => {
    let alive = true
    if (pollTimer.current) clearTimeout(pollTimer.current)

    const poll = (id: string) => {
      const tick = async () => {
        try {
          const res = await fetch(`${apiBaseUrl}/api/v1/diagnose/${id}`, { credentials: 'include' })
          if (!res.ok) throw new Error('poll failed')
          const data = (await res.json()) as DiagnosisJob
          if (!alive) return
          setJob(data)
          if (data.status === 'pending' || data.status === 'running') {
            pollTimer.current = setTimeout(tick, POLL_MS)
          }
        } catch {
          if (!alive) return
          pollTimer.current = setTimeout(tick, POLL_MS)
        }
      }
      void tick()
    }

    const start = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/v1/diagnose`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ repo: repoFullName }),
        })
        if (!res.ok) throw new Error('start failed')
        const data = (await res.json()) as { id: string; status: DiagnosisJob['status'] }
        if (!alive) return
        setJob({ id: data.id, status: data.status, progress: null, result: null, error: null })
        poll(data.id)
      } catch {
        if (!alive) return
        setStartFailed(true)
      }
    }

    void start()

    return () => {
      alive = false
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [apiBaseUrl, repoFullName, attempt])

  const jobId = job?.status === 'completed' && job.result?.structural ? job.id : null

  useEffect(() => {
    // Sem job completo ainda, ou sem WebGL: nada a buscar — `retry()`
    // (handler de clique, não efeito) já zera graph/graphState entre
    // tentativas. Nenhum setState síncrono aqui: o 'loading' é DERIVADO
    // (effectiveGraphState abaixo) em vez de marcado no topo do efeito — só
    // setamos estado de dentro do callback assíncrono, depois do fetch.
    if (!jobId || !webglAvailable) return undefined

    let alive = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GRAPH_FETCH_TIMEOUT_MS)

    void (async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/v1/diagnose/${jobId}/graph`, {
          credentials: 'include',
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('graph fetch failed')
        const data = (await res.json()) as GraphExportResult
        if (!alive) return
        setGraph(data)
        setGraphState('ready')
      } catch {
        if (!alive) return
        setGraphState('unavailable')
      } finally {
        clearTimeout(timeout)
      }
    })()

    return () => {
      alive = false
      controller.abort()
      clearTimeout(timeout)
    }
  }, [apiBaseUrl, jobId, webglAvailable])

  // 'loading' é derivado (nunca setado direto no efeito, ver acima): há job
  // completo + WebGL, mas a busca ainda não resolveu pra 'ready'/'unavailable'.
  // Sem WebGL, cai direto em 'unavailable' sem esperar setState nenhum.
  const effectiveGraphState =
    jobId && !webglAvailable
      ? 'unavailable'
      : jobId && webglAvailable && graphState === 'idle'
        ? 'loading'
        : graphState

  const loadingLabel = (progress: string | null): string => {
    if (progress === 'indexing') return t('setup.diagLoadingIndex')
    if (progress === 'reading_github') return t('setup.diagLoadingGithub')
    return t('setup.diagLoadingClone')
  }

  const isLoading = !startFailed && (!job || job.status === 'pending' || job.status === 'running')
  const isError = startFailed || job?.status === 'failed'
  const result = job?.status === 'completed' ? job.result : null

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.diagTitle')}</h2>
      <p className="wz-sub">{t('setup.diagDesc')}</p>

      {isLoading && (
        <div
          className="wz-body flex flex-col items-center justify-center"
          style={{ minHeight: 250 }}
        >
          <Loader2 className="animate-spin mb-4" size={38} style={{ color: 'var(--gl-accent)' }} />
          <p className="wz-opt-desc">{loadingLabel(job?.progress ?? null)}</p>
        </div>
      )}

      {isError && (
        <div
          className="wz-body flex flex-col items-center justify-center text-center"
          style={{ minHeight: 250 }}
        >
          <p className="wz-h" style={{ fontSize: '1.1rem' }}>
            {t('setup.diagErrorTitle')}
          </p>
          {/* job.error vem no formato "CODE: mensagem" (free-diagnosis.ts) — o
              code escolhe a dica traduzida certa; sem code reconhecido (rota
              antiga, job de antes deste PR, ou erro de rede sem job nenhum)
              cai na mensagem sanitizada atual / texto genérico de sempre. */}
          <p className="wz-err mb-4">
            {(() => {
              const code = parseDiagnosisErrorCode(job?.error ?? null)
              return code ? t(setupErrorHintKey(code)) : (job?.error ?? t('setup.diagErrorBody'))
            })()}
          </p>
          <button onClick={retry} className="wz-btn wz-btn-ghost">
            {t('setup.diagRetry')}
          </button>
        </div>
      )}

      {result?.empty && (
        <div className="wz-body flex flex-col items-center justify-center text-center">
          <p className="wz-h" style={{ fontSize: '1.1rem' }}>
            {t('setup.diagEmptyTitle')}
          </p>
          <p className="wz-opt-desc">{t('setup.diagEmptyBody')}</p>
        </div>
      )}

      {result?.structural && (
        <div className="wz-body">
          <div className={effectiveGraphState === 'ready' && graph ? 'wz-diag-layout' : undefined}>
            {effectiveGraphState === 'loading' && (
              <div className="wz-graph3d-loading">
                <Loader2 className="animate-spin" size={28} style={{ color: 'var(--gl-accent)' }} />
                <span className="wz-opt-desc">{t('setup.diagGraphLoading')}</span>
              </div>
            )}
            {effectiveGraphState === 'ready' && graph && (
              <RepoGraph3D nodes={graph.nodes} edges={graph.edges} truncated={graph.truncated} />
            )}

            <div>
              <div className="wz-diag-verdict">
                <span className="wz-diag-score">{result.healthScore}</span>
                <div>
                  <div className="wz-diag-score-label">{t('setup.diagScoreLabel')}</div>
                  <div className="wz-diag-verdict-line">
                    {t(verdictKey(result.healthScore ?? 0))}
                  </div>
                </div>
              </div>

              <div className="wz-diag-findings">
                {(result.findings ?? []).map((f, i) => (
                  <div key={i} className={`wz-diag-finding ${f.severity}`}>
                    <SeverityIcon severity={f.severity} />
                    <span>{t(findingCopyKey(f.key), f.data)}</span>
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="wz-diag-details-toggle"
                onClick={() => setShowDetails((s) => !s)}
              >
                {t('setup.diagDetailsToggle')}
              </button>

              {(showDetails || effectiveGraphState === 'unavailable') && (
                <div className="wz-diag-details">
                  {effectiveGraphState === 'unavailable' && (
                    <p className="wz-opt-desc" style={{ marginBottom: 8 }}>
                      {t('setup.diagGraphUnavailable')}
                    </p>
                  )}
                  <div>
                    <b>{t('setup.diagDetailsFiles')}:</b> {result.structural.indexedFiles}
                  </div>
                  {result.structural.largestFiles.length > 0 && (
                    <div>
                      <b>{t('setup.diagDetailsLargest')}:</b>{' '}
                      {result.structural.largestFiles.map((f) => f.file).join(', ')}
                    </div>
                  )}
                  {result.structural.mostCalledFunctions.length > 0 && (
                    <div>
                      <b>{t('setup.diagDetailsMostCalled')}:</b>{' '}
                      {result.structural.mostCalledFunctions.map((f) => f.name).join(', ')}
                    </div>
                  )}
                  <div>
                    <b>{t('setup.diagDetailsDirs')}:</b>{' '}
                    {Object.keys(result.structural.directoryInventory).join(', ')}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button onClick={onNext} disabled={isLoading} className="wz-btn wz-btn-primary">
          {result?.structural ? t('setup.diagContinue') : t('setup.next')}{' '}
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
