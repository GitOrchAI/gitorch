import React, { useState } from 'react'
import { ChevronRight, Loader2, AlertCircle } from 'lucide-react'

interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

interface StepPlanConfirmationProps {
  apiBaseUrl: string
  token: string
  plan: string
  selectedRepos: string[]
  setSelectedRepos: (repos: string[]) => void
  selectedEngines: string[]
  telegram: string
  autonomy: Record<string, number>
  onSuccess: (projects: CreatedProject[]) => void
  onBack: () => void
}

export default function StepPlanConfirmation({
  apiBaseUrl,
  token,
  plan,
  selectedRepos,
  setSelectedRepos,
  selectedEngines,
  telegram,
  autonomy,
  onSuccess,
  onBack,
}: StepPlanConfirmationProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isFree = plan === 'free'
  const isOverlimit = isFree && selectedRepos.length > 1

  const handleRemoveRepo = (fullName: string) => {
    setSelectedRepos(selectedRepos.filter((r) => r !== fullName))
  }

  const handleSubmit = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch(`${apiBaseUrl}/api/v1/setup/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repos: selectedRepos,
          engines: selectedEngines,
          telegram,
          plan,
          envConfig: {
            autonomy,
          },
        }),
      })

      if (!response.ok) {
        const errData = await response.json()
        throw new Error(errData.error || 'Falha ao processar configuração final')
      }

      const data = await response.json()

      // Plano pago → checkout do Stripe (na moeda do país do cliente). Grátis →
      // conclui direto. Se o checkout falhar, não trava a conclusão do setup.
      if (!isFree) {
        const country = (/-([A-Za-z]{2})$/.exec(navigator.language)?.[1] ?? '').toUpperCase()
        const qs = country ? `?country=${country}` : ''
        try {
          const cr = await fetch(`${apiBaseUrl}/api/billing/checkout${qs}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ planId: plan }),
          })
          if (cr.ok) {
            const cd = (await cr.json()) as { url?: string }
            if (cd.url) {
              window.location.href = cd.url
              return
            }
          }
        } catch {
          // segue pra conclusão mesmo se o checkout não abrir
        }
      }
      onSuccess(data.projects)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Confirmação e Inicialização</h2>
      <p className="text-[var(--text-secondary)] mb-6">
        Revise suas escolhas. Ao prosseguir, o sistema iniciará a clonagem dos repositórios e a
        ativação dos motores.
      </p>

      <div className="flex-1 space-y-4">
        {isOverlimit && (
          <div className="bg-[rgba(239,68,68,0.1)] border border-red-500/20 p-4 rounded-xl flex items-start gap-3">
            <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={20} />
            <div className="text-xs">
              <h5 className="font-bold text-white mb-1">Limite de Repositórios Excedido</h5>
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Você escolheu o plano **Grátis**, que permite no máximo **1 repositório ativo**.
                Remova os repositórios extras abaixo para continuar:
              </p>
            </div>
          </div>
        )}

        <div className="bg-[var(--bg-surface-elevated)] p-5 rounded-2xl border border-[var(--glass-border)] space-y-4 text-sm">
          <div>
            <span className="text-[var(--text-secondary)] block text-xs mb-1">
              Plano Selecionado
            </span>
            <span className="font-bold text-white uppercase">
              {plan === 'free' ? 'Plano Grátis' : plan.charAt(0).toUpperCase() + plan.slice(1)}
            </span>
          </div>

          <div>
            <span className="text-[var(--text-secondary)] block text-xs mb-1">Motores Ativos</span>
            <span className="font-bold text-white capitalize">{selectedEngines.join(', ')}</span>
          </div>

          <div>
            <span className="text-[var(--text-secondary)] block text-xs mb-1">
              Repositórios ({selectedRepos.length})
            </span>
            <div className="space-y-1.5 mt-2">
              {selectedRepos.map((repo) => (
                <div
                  key={repo}
                  className="flex justify-between items-center bg-[var(--bg-deep)] px-3 py-2 rounded-lg border border-[var(--glass-border)]"
                >
                  <span className="font-mono text-xs text-white">{repo}</span>
                  {isOverlimit && (
                    <button
                      onClick={() => handleRemoveRepo(repo)}
                      className="text-xs text-red-500 hover:text-red-400 font-bold px-2 py-1"
                    >
                      Remover
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {error && <p className="text-red-500 text-xs text-center mt-2">{error}</p>}
      </div>

      <div className="mt-auto flex justify-between pt-6">
        <button
          onClick={onBack}
          disabled={loading}
          className="text-[var(--text-secondary)] hover:text-white transition-colors px-4 py-2"
        >
          Voltar
        </button>
        <button
          onClick={handleSubmit}
          disabled={loading || isOverlimit}
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform cursor-pointer"
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" size={18} /> Clonando e Iniciando...
            </>
          ) : (
            <>
              Finalizar e Clonar <ChevronRight size={18} />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
