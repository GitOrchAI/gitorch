'use client'
/* eslint-disable */
import React, { useState, useEffect } from 'react'
import Header from '../../components/Header'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'

// Step Components
import StepGitHubLogin from '../../components/setup/StepGitHubLogin'
import StepTerms from '../../components/setup/StepTerms'
import StepSelectRepos from '../../components/setup/StepSelectRepos'
import StepSelectEngines from '../../components/setup/StepSelectEngines'
import StepAssistedLogin from '../../components/setup/StepAssistedLogin'
import StepAgentConfig from '../../components/setup/StepAgentConfig'
import StepPlanSelection from '../../components/setup/StepPlanSelection'
import StepPlanConfirmation from '../../components/setup/StepPlanConfirmation'
import StepRepoConfig from '../../components/setup/StepRepoConfig'

const API_BASE_URL =
  typeof window !== 'undefined'
    ? window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:4000'
      : 'http://<A1_HOST>:4000'
    : 'http://localhost:4000'

interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

export default function SetupWizard() {
  const [step, setStep] = useState(1)
  const [token, setToken] = useState('')
  const [selectedRepos, setSelectedRepos] = useState<string[]>([])
  const [selectedEngines, setSelectedEngines] = useState<string[]>(['claude-code'])
  const [telegram, setTelegram] = useState('')
  const [autonomy, setAutonomy] = useState({ sm: 3, qa: 3, ra: 3, po: 3 })
  const [plan, setPlan] = useState('free')
  const [createdProjects, setCreatedProjects] = useState<CreatedProject[]>([])

  // Capture token from OAuth callback redirect
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const storedToken = localStorage.getItem('gitorch_token')
      if (storedToken && storedToken !== token) {
        setToken(storedToken)
      }

      const params = new URLSearchParams(window.location.search)
      const urlToken = params.get('token')
      if (urlToken) {
        localStorage.setItem('gitorch_token', urlToken)
        if (urlToken !== token) {
          setToken(urlToken)
        }

        // Remove token from query parameters for clean URL
        const newUrl = window.location.pathname
        window.history.replaceState({}, '', newUrl)

        // Advance to Step 3 (Accept Terms)
        if (step !== 3) {
          setStep(3)
        }
      }
    }
  }, [token, step])

  // If token is already present and we are on step 1/2, skip to repos/terms
  useEffect(() => {
    if (token && (step === 1 || step === 2)) {
      if (step !== 3) {
        setStep(3)
      }
    }
  }, [token, step])

  const nextStep = () => {
    if (step < 10) setStep(step + 1)
  }

  const prevStep = () => {
    if (step > 1) setStep(step - 1)
  }

  const handleSetupSuccess = (projects: CreatedProject[]) => {
    setCreatedProjects(projects)
    setStep(10) // Go to final Step 10
  }

  return (
    <main className="min-h-screen flex flex-col bg-[var(--bg-deep)]">
      <Header />

      <div className="flex-1 container mx-auto px-8 flex flex-col items-center py-12">
        {/* Progress Bar */}
        <div className="w-full max-w-2xl mb-12 flex justify-between relative">
          <div className="absolute top-1/2 left-0 w-full h-[2px] bg-[var(--glass-border)] -z-10" />
          <div
            className="absolute top-1/2 left-0 h-[2px] bg-[var(--accent-neon-violet)] -z-10 transition-all duration-500"
            style={{ width: `${((step - 1) / 9) * 100}%` }}
          />

          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
            <StepIndicator key={num} currentStep={step} stepNum={num} />
          ))}
        </div>

        {/* Wizard Panel */}
        <div className="glass-panel w-full max-w-2xl p-8 min-h-[460px] relative overflow-hidden flex flex-col justify-between">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full justify-between flex-1"
              >
                <div>
                  <h2 className="text-3xl font-bold mb-4">Inicie sua Configuração</h2>
                  <p className="text-[var(--text-secondary)] mb-8 leading-relaxed">
                    Bem-vindo ao Setup Wizard do GitOrch. Vamos configurar o isolamento do seu
                    ambiente, conectar seus repositórios e preparar seus agentes inteligentes para
                    codificar de forma autônoma.
                  </p>
                </div>
                <div className="mt-auto flex justify-end">
                  <button
                    onClick={nextStep}
                    className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 hover:scale-105 transition-transform cursor-pointer"
                  >
                    Começar <ChevronRight size={18} />
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
                  token={token}
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
                <StepAssistedLogin
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
                <StepAgentConfig
                  telegram={telegram}
                  setTelegram={setTelegram}
                  autonomy={autonomy}
                  setAutonomy={setAutonomy}
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
                  token={token}
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
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col h-full flex-1"
              >
                <StepRepoConfig projects={createdProjects} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  )
}

function StepIndicator({ currentStep, stepNum }: { currentStep: number; stepNum: number }) {
  const active = currentStep >= stepNum
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs transition-colors duration-500 ${
          active
            ? 'bg-[#7c3aed] text-white glow-border'
            : 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--glass-border)]'
        }`}
      >
        {stepNum}
      </div>
    </div>
  )
}
