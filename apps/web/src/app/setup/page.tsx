'use client'
import React, { useState, useEffect } from 'react'
import { API_BASE_URL } from '../../lib/api'
import { useLanguage } from '../../LanguageContext'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import WizardShell from '../../components/setup/WizardShell'

// Step Components
import StepGitHubLogin from '../../components/setup/StepGitHubLogin'
import StepTerms from '../../components/setup/StepTerms'
import StepSelectRepos from '../../components/setup/StepSelectRepos'
import StepDiagnosis from '../../components/setup/StepDiagnosis'
import StepSelectEngines from '../../components/setup/StepSelectEngines'
import StepConnectEngine from '../../components/setup/StepConnectEngine'
import StepTelegram from '../../components/setup/StepTelegram'
import StepPlanSelection from '../../components/setup/StepPlanSelection'
import StepPlanConfirmation from '../../components/setup/StepPlanConfirmation'
import StepReady from '../../components/setup/StepReady'
// Forma dos projetos recém-criados (com a chave em claro): fonte única em
// submit-flow, o módulo que fala com o backend.
import type { CreatedProject } from '../../components/setup/submit-flow'
// Resolução do plano ativo (URL > sessionStorage > free) — fonte única com o
// backend (routes/auth.ts), que devolve ?plan= no redirect pós-OAuth.
import { resolvePlan, PLAN_STORAGE_KEY } from '../../components/setup/plan-persistence'

const TOTAL_STEPS = 11

export default function SetupWizard() {
  const { t } = useLanguage()
  const [step, setStep] = useState(1)
  // Sessão vive num cookie httpOnly (não lido por JS) — o front só sabe SE
  // está autenticado, nunca o valor do token (spec §17.4, sem token em
  // URL/localStorage).
  const [authenticated, setAuthenticated] = useState(false)
  const [selectedRepos, setSelectedRepos] = useState<string[]>([])
  const [selectedEngines, setSelectedEngines] = useState<string[]>(['claude-code'])
  // Sem estado de telegram aqui: o vínculo NÃO é um campo de formulário que
  // viaja no submit — ele nasce no backend (token -> /start -> chat_id) e vive
  // em telegram_links. Guardar um @username aqui era o que fazia o passo 8
  // prometer um aviso que nunca chegava.
  // Autonomia dos 4 papéis: default sensato enviado ao submit (envConfig). Os
  // sliders manuais saíram do wizard (Task 3.4) — autonomia/cadência vira
  // ajuste fino no painel, não fricção no onboarding.
  const [autonomy] = useState({ sm: 3, qa: 3, ra: 3, po: 3 })
  // Plano pré-selecionado pela landing (/setup?plan=solo) — derivado da URL no
  // inicializador (não num effect com setState síncrono). O plano só aparece a
  // partir do passo 8, então não há divergência de hidratação no passo 1.
  // Prioridade URL > sessionStorage > 'free' (plan-persistence.ts): a URL é o
  // sinal mais recente (inclusive o que o backend devolve no redirect pós-
  // OAuth); o sessionStorage é o fallback pro caso raro de a volta não
  // carregar a query.
  const [plan, setPlan] = useState<string>(() => {
    if (typeof window === 'undefined') return 'free'
    return resolvePlan(window.location.search, sessionStorage.getItem(PLAN_STORAGE_KEY))
  })
  // Intenção de entrada: veio da landing com um plano PAGO no ?plan? Então o
  // passo de plano confirma essa escolha (não pede pra escolher do zero), e o
  // funil trata o cliente como quem já decidiu — pode ajustar, sem fricção.
  const [entryPaidIntent] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const urlPlan = new URLSearchParams(window.location.search).get('plan')
    return !!urlPlan && ['solo', 'pro', 'team'].includes(urlPlan)
  })
  const [createdProjects, setCreatedProjects] = useState<CreatedProject[]>([])

  // Bug real (18/07): quem entrava com ?plan=pro e logava com GitHub voltava
  // do OAuth como 'free'. O login é uma navegação de página INTEIRA — este
  // componente remonta do zero, e o useState acima já cobre o caso comum. Este
  // efeito é a defesa extra: roda de novo pós-mount (cobre navegação client-
  // side que mude a query sem remontar) e SEMPRE persiste o resultado em
  // sessionStorage, pra sobreviver mesmo se uma volta futura não carregar a
  // query.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const resolved = resolvePlan(window.location.search, sessionStorage.getItem(PLAN_STORAGE_KEY))
    setPlan(resolved)
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') sessionStorage.setItem(PLAN_STORAGE_KEY, plan)
  }, [plan])

  // Verifica a sessão real no servidor (cookie httpOnly enviado automaticamente).
  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE_URL}/api/v1/auth/me`, { credentials: 'include' })
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setAuthenticated(true)
          setStep((current) => (current === 1 || current === 2 ? 3 : current))
        }
      })
      .catch(() => {
        // Sem sessão ainda — permanece nos passos iniciais de login.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const nextStep = () => {
    if (step < TOTAL_STEPS) setStep(step + 1)
  }

  const prevStep = () => {
    if (step > 1) setStep(step - 1)
  }

  const handleSetupSuccess = (projects: CreatedProject[]) => {
    setCreatedProjects(projects)
    setStep(TOTAL_STEPS) // Go to final step
  }

  const progressPct = ((step - 1) / (TOTAL_STEPS - 1)) * 100

  return (
    <WizardShell>
      <main className="wz-wrap">
        {/* Barra de progresso real */}
        <div className="wz-progress">
          <div className="wz-progress-track">
            <div className="wz-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="wz-steps">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((num) => (
              <div key={num} className={`wz-dot${step >= num ? ' is-active' : ''}`}>
                {num}
              </div>
            ))}
          </div>
        </div>

        {/* Painel do passo */}
        <div className="wz-panel">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <div className="wz-body">
                  <h2 className="wz-h">{t('setup.welcomeTitle')}</h2>
                  <p className="wz-sub">{t('setup.welcomeDesc')}</p>
                </div>
                <div className="wz-actions">
                  <span />
                  <button onClick={nextStep} className="wz-btn wz-btn-primary">
                    {t('setup.begin')} <ChevronRight size={18} />
                  </button>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepGitHubLogin apiBaseUrl={API_BASE_URL} plan={plan} />
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepTerms onAccept={nextStep} />
              </motion.div>
            )}

            {step === 4 && (
              <motion.div
                key="step4"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepSelectRepos
                  apiBaseUrl={API_BASE_URL}
                  authenticated={authenticated}
                  selectedRepos={selectedRepos}
                  setSelectedRepos={setSelectedRepos}
                  plan={plan}
                  onNext={nextStep}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 5 && (
              <motion.div
                key="step5"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepDiagnosis
                  apiBaseUrl={API_BASE_URL}
                  repoFullName={selectedRepos[0] ?? ''}
                  onNext={nextStep}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 6 && (
              <motion.div
                key="step6"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepSelectEngines
                  selectedEngines={selectedEngines}
                  setSelectedEngines={setSelectedEngines}
                  onNext={nextStep}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 7 && (
              <motion.div
                key="step7"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepConnectEngine
                  apiBaseUrl={API_BASE_URL}
                  selectedEngines={selectedEngines}
                  onNext={nextStep}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 8 && (
              <motion.div
                key="step8"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepTelegram apiBaseUrl={API_BASE_URL} onNext={nextStep} onBack={prevStep} />
              </motion.div>
            )}

            {step === 9 && (
              <motion.div
                key="step9"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepPlanSelection
                  plan={plan}
                  setPlan={setPlan}
                  entryPaidIntent={entryPaidIntent}
                  onNext={nextStep}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 10 && (
              <motion.div
                key="step10"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full flex-1"
              >
                <StepPlanConfirmation
                  apiBaseUrl={API_BASE_URL}
                  plan={plan}
                  selectedRepos={selectedRepos}
                  setSelectedRepos={setSelectedRepos}
                  selectedEngines={selectedEngines}
                  autonomy={autonomy}
                  onSuccess={handleSetupSuccess}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 11 && (
              <motion.div
                key="step11"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col h-full flex-1"
              >
                {/* `plan` aqui não é decoração: é o StepReady que leva ao
                    pagamento, DEPOIS de mostrar a chave. */}
                <StepReady projects={createdProjects} apiBaseUrl={API_BASE_URL} plan={plan} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </WizardShell>
  )
}
