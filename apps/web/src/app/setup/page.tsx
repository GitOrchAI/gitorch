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
import StepSelectEngines from '../../components/setup/StepSelectEngines'
import StepConnectEngine from '../../components/setup/StepConnectEngine'
import StepTelegram from '../../components/setup/StepTelegram'
import StepPlanSelection from '../../components/setup/StepPlanSelection'
import StepPlanConfirmation from '../../components/setup/StepPlanConfirmation'
import StepRepoConfig from '../../components/setup/StepRepoConfig'

interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

const TOTAL_STEPS = 10

export default function SetupWizard() {
  const { t } = useLanguage()
  const [step, setStep] = useState(1)
  // Sessão vive num cookie httpOnly (não lido por JS) — o front só sabe SE
  // está autenticado, nunca o valor do token (spec §17.4, sem token em
  // URL/localStorage).
  const [authenticated, setAuthenticated] = useState(false)
  const [selectedRepos, setSelectedRepos] = useState<string[]>([])
  const [selectedEngines, setSelectedEngines] = useState<string[]>(['claude-code'])
  const [telegram, setTelegram] = useState('')
  // Autonomia dos 4 papéis: default sensato enviado ao submit (envConfig). Os
  // sliders manuais saíram do wizard (Task 3.4) — autonomia/cadência vira
  // ajuste fino no painel, não fricção no onboarding.
  const [autonomy] = useState({ sm: 3, qa: 3, ra: 3, po: 3 })
  // Plano pré-selecionado pela landing (/setup?plan=solo) — derivado da URL no
  // inicializador (não num effect com setState síncrono). O plano só aparece a
  // partir do passo 8, então não há divergência de hidratação no passo 1.
  const [plan, setPlan] = useState<string>(() => {
    if (typeof window === 'undefined') return 'free'
    const urlPlan = new URLSearchParams(window.location.search).get('plan')
    return urlPlan && ['free', 'solo', 'pro', 'team'].includes(urlPlan) ? urlPlan : 'free'
  })
  const [createdProjects, setCreatedProjects] = useState<CreatedProject[]>([])

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
                <StepGitHubLogin apiBaseUrl={API_BASE_URL} />
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
                <StepSelectEngines
                  selectedEngines={selectedEngines}
                  setSelectedEngines={setSelectedEngines}
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
                <StepConnectEngine
                  apiBaseUrl={API_BASE_URL}
                  selectedEngines={selectedEngines}
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
                <StepTelegram
                  telegram={telegram}
                  setTelegram={setTelegram}
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
                <StepPlanSelection
                  plan={plan}
                  setPlan={setPlan}
                  onNext={nextStep}
                  onBack={prevStep}
                />
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
                <StepPlanConfirmation
                  apiBaseUrl={API_BASE_URL}
                  plan={plan}
                  selectedRepos={selectedRepos}
                  setSelectedRepos={setSelectedRepos}
                  selectedEngines={selectedEngines}
                  telegram={telegram}
                  autonomy={autonomy}
                  onSuccess={handleSetupSuccess}
                  onBack={prevStep}
                />
              </motion.div>
            )}

            {step === 10 && (
              <motion.div
                key="step10"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col h-full flex-1"
              >
                <StepRepoConfig projects={createdProjects} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </WizardShell>
  )
}
