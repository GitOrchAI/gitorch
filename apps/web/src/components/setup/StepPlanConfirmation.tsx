import React, { useState } from 'react'
import { ChevronRight, Loader2, AlertCircle } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import { isPaidPlan, submitSetup, type CreatedProject } from './submit-flow'

interface StepPlanConfirmationProps {
  apiBaseUrl: string
  plan: string
  selectedRepos: string[]
  setSelectedRepos: (repos: string[]) => void
  selectedEngines: string[]
  autonomy: Record<string, number>
  onSuccess: (projects: CreatedProject[]) => void
  onBack: () => void
}

export default function StepPlanConfirmation({
  apiBaseUrl,
  plan,
  selectedRepos,
  setSelectedRepos,
  selectedEngines,
  autonomy,
  onSuccess,
  onBack,
}: StepPlanConfirmationProps) {
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isPaid = isPaidPlan(plan)
  const isFree = !isPaid
  const isOverlimit = isFree && selectedRepos.length > 1

  const handleRemoveRepo = (fullName: string) => {
    setSelectedRepos(selectedRepos.filter((r) => r !== fullName))
  }

  /**
   * Cria o ambiente e SEGUE PARA O PASSO FINAL — pago ou grátis, o mesmo caminho.
   *
   * Aqui morava a promessa quebrada: no plano pago, o submit emendava num redirect
   * automático pro Stripe e dava `return`, pulando o StepReady. Como o StepReady é
   * o ÚNICO lugar que renderiza a chave de API — e o texto puro dela só existe
   * nesta resposta (o banco guarda só o hash) — quem PAGAVA saía do funil sem
   * nunca ter visto a própria credencial, e ela era irrecuperável.
   *
   * Agora este passo não navega para lugar nenhum. Ele entrega os projetos (com a
   * chave) para a memória do wizard, e o pagamento vira um botão no StepReady —
   * depois de a chave estar na tela, com o aviso de que é a única exibição.
   * A guarda em submit-flow.test.ts existe para que ninguém reintroduza o
   * redirect: este componente não pode conter navegação, ponto.
   */
  const handleSubmit = async () => {
    try {
      setLoading(true)
      setError(null)
      const projects = await submitSetup(
        {
          apiBaseUrl,
          plan,
          repos: selectedRepos,
          engines: selectedEngines,
          autonomy,
        },
        { fallbackError: t('setup.reposError') }
      )
      onSuccess(projects)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('setup.reposError'))
    } finally {
      setLoading(false)
    }
  }

  const planLabel = isFree
    ? t('setup.confirmFreePlan')
    : plan.charAt(0).toUpperCase() + plan.slice(1)

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.confirmTitle')}</h2>
      <p className="wz-sub">{t('setup.confirmDesc')}</p>

      <div className="wz-body space-y-4">
        {isOverlimit && (
          <div
            className="flex items-start gap-3 rounded-xl p-4"
            style={{ background: 'var(--gl-accent-soft)', border: '1px solid var(--gl-hair)' }}
          >
            <AlertCircle size={20} style={{ color: 'var(--gl-sev)', flex: 'none', marginTop: 2 }} />
            <div style={{ fontSize: '0.8rem' }}>
              <h5 style={{ fontWeight: 600, color: 'var(--gl-ink)', marginBottom: 4 }}>
                {t('setup.confirmOverTitle')}
              </h5>
              <p className="wz-opt-desc">{t('setup.confirmOverBody')}</p>
            </div>
          </div>
        )}

        <div
          className="space-y-4 rounded-2xl p-5"
          style={{ background: 'var(--gl-canvas)', border: '1px solid var(--gl-hair)' }}
        >
          <div>
            <span className="wz-opt-desc block">{t('setup.confirmPlanLabel')}</span>
            <span className="wz-opt-title" style={{ textTransform: 'uppercase' }}>
              {planLabel}
            </span>
          </div>

          <div>
            <span className="wz-opt-desc block">{t('setup.confirmEnginesLabel')}</span>
            <span className="wz-opt-title" style={{ textTransform: 'capitalize' }}>
              {selectedEngines.join(', ')}
            </span>
          </div>

          <div>
            <span className="wz-opt-desc block">
              {t('setup.confirmReposLabel')} ({selectedRepos.length})
            </span>
            <div className="mt-2 space-y-1.5">
              {selectedRepos.map((repo) => (
                <div
                  key={repo}
                  className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: 'var(--gl-surface-2)', border: '1px solid var(--gl-hair)' }}
                >
                  <span
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: '0.78rem',
                      color: 'var(--gl-ink)',
                    }}
                  >
                    {repo}
                  </span>
                  {isOverlimit && (
                    <button
                      onClick={() => handleRemoveRepo(repo)}
                      style={{ fontSize: '0.74rem', color: 'var(--gl-sev)', fontWeight: 600 }}
                    >
                      {t('setup.confirmRemove')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Plano pago: diz na cara a ordem do que vem — primeiro a chave, depois o
            pagamento. Ninguém é jogado num checkout sem aviso. */}
        {isPaid && <p className="wz-opt-desc">{t('setup.confirmPayNext')}</p>}

        {error && <p className="wz-err text-center">{error}</p>}
      </div>

      <div className="wz-actions">
        <button onClick={onBack} disabled={loading} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button
          onClick={handleSubmit}
          disabled={loading || isOverlimit}
          className="wz-btn wz-btn-primary"
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" size={18} /> {t('setup.confirmSubmitting')}
            </>
          ) : (
            <>
              {t('setup.confirmSubmit')} <ChevronRight size={18} />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
