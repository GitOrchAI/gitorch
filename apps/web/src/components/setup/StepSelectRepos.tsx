import React, { useEffect, useState } from 'react'
import { ChevronRight, Search, Loader2 } from 'lucide-react'

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
  onNext: () => void
  onBack: () => void
}

export default function StepSelectRepos({
  apiBaseUrl,
  authenticated,
  selectedRepos,
  setSelectedRepos,
  onNext,
  onBack,
}: StepSelectReposProps) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

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
          throw new Error('Falha ao buscar repositórios do GitHub.')
        }

        const data = await response.json()
        setRepos(data)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Erro inesperado')
      } finally {
        setLoading(false)
      }
    }

    if (authenticated) {
      fetchRepos()
    }
  }, [apiBaseUrl, authenticated])

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
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Selecione seus Repositórios</h2>
      <p className="text-[var(--text-secondary)] mb-6">
        Selecione em quais repositórios os agentes de IA do GitOrch atuarão.
      </p>

      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[250px]">
          <Loader2 className="animate-spin text-[#7c3aed] mb-4" size={40} />
          <p className="text-[var(--text-secondary)] text-sm">
            Carregando seus repositórios do GitHub...
          </p>
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[250px] text-center">
          <p className="text-red-500 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="border border-[var(--glass-border)] px-4 py-2 rounded-full text-sm font-semibold hover:bg-[var(--bg-surface-elevated)]"
          >
            Tentar Novamente
          </button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-[250px]">
          <div className="flex items-center gap-3 bg-[var(--bg-surface-elevated)] px-4 py-3 rounded-xl border border-[var(--glass-border)] mb-4">
            <Search className="text-[var(--text-secondary)]" size={18} />
            <input
              type="text"
              placeholder="Buscar repositório..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent border-none outline-none flex-1 text-sm text-white placeholder:text-[var(--text-secondary)]"
            />
          </div>

          <div className="flex-1 overflow-y-auto max-h-56 space-y-2 pr-1">
            {filteredRepos.length === 0 ? (
              <p className="text-center text-[var(--text-secondary)] text-sm py-8">
                Nenhum repositório encontrado.
              </p>
            ) : (
              filteredRepos.map((repo) => {
                const isChecked = selectedRepos.includes(repo.fullName)
                return (
                  <div
                    key={repo.id}
                    onClick={() => toggleRepo(repo.fullName)}
                    className={`flex items-start gap-4 p-4 rounded-xl border transition-all cursor-pointer ${
                      isChecked
                        ? 'bg-[rgba(124,58,237,0.05)] border-[#7c3aed]'
                        : 'bg-[var(--bg-surface-elevated)] border-[var(--glass-border)] hover:border-[#ffffff20]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}} // Handle via parent div click
                      className="w-5 h-5 mt-0.5 rounded border-[var(--glass-border)] text-[#7c3aed] focus:ring-[#7c3aed] bg-transparent pointer-events-none"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm">{repo.fullName}</span>
                        {repo.private && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[rgba(244,114,182,0.1)] text-[#f472b6] border border-[rgba(244,114,182,0.2)]">
                            Privado
                          </span>
                        )}
                      </div>
                      {repo.description && (
                        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-1">
                          {repo.description}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      <div className="mt-auto flex justify-between pt-6">
        <button
          onClick={onBack}
          className="text-[var(--text-secondary)] hover:text-white transition-colors px-4 py-2"
        >
          Voltar
        </button>
        <button
          onClick={onNext}
          disabled={selectedRepos.length === 0}
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform cursor-pointer"
        >
          Avançar <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
