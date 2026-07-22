import React, { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { ChevronRight, Search, Loader2, Check } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import { parseSetupErrorCode, setupErrorHintKey, type SetupErrorCode } from './setup-errors'
import { isWebglAvailable } from './graph3d-layout'

const RepoGraph3D = dynamic(() => import('./RepoGraph3D'), { ssr: false })

const PREP_NODES = [
  { id: 'env', label: 'isolated-env', file: '/env', type: 'dir', health: 'good' as const },
  {
    id: 'manifest',
    label: 'manifest-lock',
    file: '/manifest.json',
    type: 'file',
    health: 'good' as const,
  },
  { id: 'cgc', label: 'cgc-graph', file: '/graph.json', type: 'file', health: 'good' as const },
  { id: 'engine', label: 'cli-runtimes', file: '/runtimes', type: 'dir', health: 'good' as const },
]
const PREP_EDGES = [
  { source: 'env', target: 'manifest', rel: 'imports' },
  { source: 'env', target: 'cgc', rel: 'indexes' },
  { source: 'env', target: 'engine', rel: 'executes' },
]

interface Repo {
  id: number
  name: string
  fullName: string
  description: string | null
  private: boolean
  url: string
}

interface StepSelectReposProps {
  apiBaseUrl: string
  authenticated: boolean
  selectedRepos: string[]
  setSelectedRepos: (repos: string[]) => void
  plan: string
  hostingMode?: 'cloud' | 'vm'
  onNext: () => void
  onBack: () => void
}

export function getPlanRepoLimit(plan: string, hostingMode: 'cloud' | 'vm' = 'cloud'): number {
  if (hostingMode === 'vm') return Infinity
  switch (plan.toLowerCase()) {
    case 'solo':
      return 2
    case 'pro':
      return 5
    case 'team':
      return 15
    case 'free':
    default:
      return 1
  }
}

export default function StepSelectRepos({
  apiBaseUrl,
  authenticated,
  selectedRepos,
  setSelectedRepos,
  plan,
  hostingMode = 'cloud',
  onNext,
  onBack,
}: StepSelectReposProps) {
  const { t } = useLanguage()
  const [repos, setRepos] = useState<Repo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Code classificado da falha ao LISTAR os repos (GET /github/repos) — hoje o
  // único que o front trata de forma especial é GITHUB_TOKEN_EXPIRED (token
  // OAuth expirado/revogado), que troca o botão "tentar de novo" por um
  // atalho direto pro login do GitHub. null = rota antiga/erro de
  // rede/JSON malformado, cai no aviso genérico de sempre.
  const [reposErrorCode, setReposErrorCode] = useState<SetupErrorCode | null>(null)
  const [search, setSearch] = useState('')
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  // Code classificado (REPO_ACCESS_DENIED, CLONE_TIMEOUT etc.) — quando a
  // rota devolve um, mostramos a dica traduzida específica além do aviso
  // genérico. null = rota antiga/erro de rede/JSON malformado.
  const [cloneErrorCode, setCloneErrorCode] = useState<SetupErrorCode | null>(null)
  const [resetting, setResetting] = useState(false)
  const [limitExceeded, setLimitExceeded] = useState(false)

  const repoLimit = getPlanRepoLimit(plan, hostingMode)

  // Ao avançar, clona os repos escolhidos DENTRO do ambiente isolado do cliente
  // (passo 4). Só segue quando o clone termina; falha mantém a pessoa no passo
  // com um aviso, sem avançar.
  const handleNext = async () => {
    if (selectedRepos.length === 0 || cloning) return
    setCloning(true)
    setCloneError(null)
    setCloneErrorCode(null)
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/setup/clone`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos }),
      })
      if (!res.ok) {
        // Lê o corpo {error, code} da rota (contrato de erro) em vez de só o
        // status HTTP — o code escolhe a dica traduzida certa (dica genérica
        // "tente de novo" some quando sabemos exatamente o que aconteceu).
        const body = await res.json().catch(() => null)
        setCloneErrorCode(parseSetupErrorCode(body))
        throw new Error(String(res.status))
      }
      onNext()
    } catch {
      setCloneError(t('setup.cloneError'))
      setCloning(false)
    }
  }

  // "Recomeçar do zero": destrói o ambiente atual (clone quebrado incluso) e
  // cria outro vazio, depois recarrega a página — a forma mais simples de
  // voltar ao início do wizard com um estado limpo garantido pelo servidor.
  // Best-effort: mesmo se a chamada falhar (rede), recarregar ainda ajuda —
  // o próximo passo cria um ambiente novo do mesmo jeito.
  const startOver = async () => {
    setResetting(true)
    try {
      await fetch(`${apiBaseUrl}/api/v1/setup/environment/reset`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // melhor esforço — ver comentário acima
    } finally {
      window.location.reload()
    }
  }

  useEffect(() => {
    const fetchRepos = async () => {
      try {
        setLoading(true)
        setError(null)
        setReposErrorCode(null)
        // Sessão via cookie httpOnly, enviada automaticamente pelo navegador
        // (spec §17.4 — nunca mais um token lido/manipulado pelo JS).
        const response = await fetch(`${apiBaseUrl}/api/v1/github/repos`, {
          credentials: 'include',
        })

        if (!response.ok) {
          // Lê o corpo {error, code} (mesmo contrato do POST /setup/clone) —
          // achado real do QA (19/07): token GitHub expirado/revogado
          // devolvia 401 cru do lado do GitHub, e este passo só mostrava um
          // aviso genérico sem indicar o que fazer.
          const body = await response.json().catch(() => null)
          setReposErrorCode(parseSetupErrorCode(body))
          throw new Error(t('setup.reposError'))
        }

        const data = await response.json()
        setRepos(data)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : t('setup.reposError'))
      } finally {
        setLoading(false)
      }
    }

    if (authenticated) {
      fetchRepos()
    }
  }, [apiBaseUrl, authenticated, t])

  // Mesma lógica de StepGitHubLogin: manda a pessoa de volta pro login do
  // GitHub, dizendo à API pra onde voltar (allowlist validada no backend) e
  // com que plano — usado quando o token expirou/foi revogado
  // (GITHUB_TOKEN_EXPIRED) e "tentar de novo" não resolveria nada.
  const signInAgain = () => {
    const base = window.location.href.split('/setup')[0]
    const returnTo = encodeURIComponent(base)
    const planParam = encodeURIComponent(plan)
    window.location.href = `${apiBaseUrl}/api/v1/auth/github?return_to=${returnTo}&plan=${planParam}`
  }

  const toggleRepo = (fullName: string) => {
    if (selectedRepos.includes(fullName)) {
      // Desmarcar sempre pode, e limpa o aviso de cota.
      setSelectedRepos(selectedRepos.filter((r) => r !== fullName))
      setLimitExceeded(false)
    } else {
      // TRAVA REAL: não deixa passar do teto do plano (o banner só aparecia
      // porque o setter nunca era chamado — a trava era um no-op). O backend
      // valida de novo o teto (defesa em profundidade, anti-burla).
      if (selectedRepos.length >= repoLimit) {
        setLimitExceeded(true)
        return
      }
      setSelectedRepos([...selectedRepos, fullName])
      setLimitExceeded(false)
    }
  }

  const filteredRepos = repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(search.toLowerCase()) ||
      repo.fullName.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.reposTitle')}</h2>
      <p className="wz-sub">{t('setup.reposDesc')}</p>

      {cloning ? (
        <div
          className="wz-body flex flex-col items-center justify-center relative overflow-hidden"
          style={{ minHeight: 280 }}
        >
          {isWebglAvailable() ? (
            <div className="w-full h-48 mb-3 rounded-lg overflow-hidden border border-gray-800">
              <RepoGraph3D nodes={PREP_NODES} edges={PREP_EDGES} truncated={false} />
            </div>
          ) : (
            <Loader2
              className="animate-spin mb-4"
              size={38}
              style={{ color: 'var(--gl-accent)' }}
            />
          )}
          <p className="wz-opt-desc flex items-center gap-2">
            <Loader2 className="animate-spin" size={16} />
            {t('setup.reposCloning')}
          </p>
        </div>
      ) : loading ? (
        <div
          className="wz-body flex flex-col items-center justify-center"
          style={{ minHeight: 250 }}
        >
          <Loader2 className="animate-spin mb-4" size={38} style={{ color: 'var(--gl-accent)' }} />
          <p className="wz-opt-desc">{t('setup.reposLoading')}</p>
        </div>
      ) : error ? (
        <div
          className="wz-body flex flex-col items-center justify-center text-center"
          style={{ minHeight: 250 }}
        >
          <p className="wz-err mb-4">{error}</p>
          {reposErrorCode && (
            <p className="wz-opt-desc mb-4">{t(setupErrorHintKey(reposErrorCode))}</p>
          )}
          {reposErrorCode === 'GITHUB_TOKEN_EXPIRED' ? (
            <button onClick={signInAgain} className="wz-btn wz-btn-primary">
              {t('setup.reposSignInAgain')}
            </button>
          ) : (
            <button onClick={() => window.location.reload()} className="wz-btn wz-btn-ghost">
              {t('setup.retry')}
            </button>
          )}
        </div>
      ) : (
        <div className="wz-body flex flex-col" style={{ minHeight: 250 }}>
          <div className="mb-4 flex items-center gap-3">
            <div style={{ position: 'relative', flex: 1 }}>
              <Search
                size={16}
                style={{
                  position: 'absolute',
                  left: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--gl-faint)',
                }}
              />
              <input
                type="text"
                placeholder={t('setup.reposSearch')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="wz-field"
                style={{ paddingLeft: 38 }}
              />
            </div>
          </div>

          {plan === 'free' && (
            <p
              className="mb-3 rounded-lg px-3 py-2"
              style={{
                background: 'var(--gl-accent-soft)',
                color: 'var(--gl-accent-ink)',
                fontSize: '0.78rem',
                lineHeight: 1.45,
              }}
            >
              {t('setup.reposFreeNote')}
            </p>
          )}

          {limitExceeded && (
            <p
              className="mb-3 rounded-lg px-3 py-2 flex items-center justify-between"
              style={{
                background: 'var(--gl-accent-soft)',
                color: 'var(--gl-accent-ink)',
                fontSize: '0.78rem',
                lineHeight: 1.45,
              }}
            >
              <span>
                Limite do plano ({plan.toUpperCase()}): máximo de {repoLimit} repositório(s) na
                nuvem.
              </span>
            </p>
          )}

          <div className="flex-1 space-y-2 overflow-y-auto pr-1" style={{ maxHeight: '14rem' }}>
            {filteredRepos.length === 0 ? (
              <p className="wz-opt-desc py-8 text-center">{t('setup.reposEmpty')}</p>
            ) : (
              filteredRepos.map((repo) => {
                const isChecked = selectedRepos.includes(repo.fullName)
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => toggleRepo(repo.fullName)}
                    className={`wz-opt${isChecked ? ' is-selected' : ''}`}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="flex items-center gap-2">
                        <span className="wz-opt-title" style={{ fontSize: '0.9rem' }}>
                          {repo.fullName}
                        </span>
                        {repo.private && (
                          <span
                            style={{
                              fontSize: '0.62rem',
                              fontWeight: 700,
                              padding: '1px 8px',
                              borderRadius: 999,
                              background: 'var(--gl-accent-soft)',
                              color: 'var(--gl-accent-ink)',
                            }}
                          >
                            {t('setup.reposPrivate')}
                          </span>
                        )}
                      </div>
                      {repo.description && (
                        <p className="wz-opt-desc truncate">{repo.description}</p>
                      )}
                    </div>
                    {isChecked && (
                      <span className="wz-ok" style={{ flex: 'none' }}>
                        <Check size={16} />
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}

      {cloneError && (
        <div className="mt-3">
          <p style={{ fontSize: '0.85rem', color: 'var(--gl-danger, #d33)' }}>{cloneError}</p>
          {cloneErrorCode && (
            <p className="wz-opt-desc" style={{ marginTop: 4 }}>
              {t(setupErrorHintKey(cloneErrorCode))}
            </p>
          )}
          <button
            type="button"
            onClick={startOver}
            disabled={resetting}
            className="wz-btn wz-btn-ghost"
            style={{ marginTop: 8, fontSize: '0.8rem' }}
          >
            {t('setup.startOver')}
          </button>
        </div>
      )}

      <div className="wz-actions">
        <button onClick={onBack} disabled={cloning} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button
          onClick={handleNext}
          disabled={selectedRepos.length === 0 || cloning}
          className="wz-btn wz-btn-primary"
        >
          {cloning ? t('setup.reposCloning') : t('setup.next')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
