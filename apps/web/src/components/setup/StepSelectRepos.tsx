import React, { useEffect, useState } from 'react'
import { ChevronRight, Search, Loader2, Check } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

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
  onNext: () => void
  onBack: () => void
}

export default function StepSelectRepos({
  apiBaseUrl,
  authenticated,
  selectedRepos,
  setSelectedRepos,
  plan,
  onNext,
  onBack,
}: StepSelectReposProps) {
  const { t } = useLanguage()
  const [repos, setRepos] = useState<Repo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)

  // Ao avançar, clona os repos escolhidos DENTRO do ambiente isolado do cliente
  // (passo 4). Só segue quando o clone termina; falha mantém a pessoa no passo
  // com um aviso, sem avançar.
  const handleNext = async () => {
    if (selectedRepos.length === 0 || cloning) return
    setCloning(true)
    setCloneError(null)
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/setup/clone`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos }),
      })
      if (!res.ok) throw new Error(String(res.status))
      onNext()
    } catch {
      setCloneError(t('setup.cloneError'))
      setCloning(false)
    }
  }

  useEffect(() => {
    const fetchRepos = async () => {
      try {
        setLoading(true)
        setError(null)
        // Sessão via cookie httpOnly, enviada automaticamente pelo navegador
        // (spec §17.4 — nunca mais um token lido/manipulado pelo JS).
        const response = await fetch(`${apiBaseUrl}/api/v1/github/repos`, {
          credentials: 'include',
        })

        if (!response.ok) {
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

  const toggleRepo = (fullName: string) => {
    if (selectedRepos.includes(fullName)) {
      setSelectedRepos(selectedRepos.filter((r) => r !== fullName))
    } else {
      setSelectedRepos([...selectedRepos, fullName])
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

      {loading ? (
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
          <button onClick={() => window.location.reload()} className="wz-btn wz-btn-ghost">
            {t('setup.retry')}
          </button>
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
        <p className="mt-3" style={{ fontSize: '0.85rem', color: 'var(--gl-danger, #d33)' }}>
          {cloneError}
        </p>
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
