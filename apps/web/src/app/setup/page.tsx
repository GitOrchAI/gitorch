'use client'

import React, { useState } from 'react'
import { useLanguage } from '../../LanguageContext'
import Header from '../../components/Header'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, ChevronRight, GitBranch, Terminal } from 'lucide-react'
import Link from 'next/link'

export default function SetupWizard() {
  const { t } = useLanguage()
  const [step, setStep] = useState(1)
  const [repo, setRepo] = useState('')
  const [prompt, setPrompt] = useState('')

  const nextStep = () => {
    if (step < 3) setStep(step + 1)
  }

  return (
    <main className="min-h-screen flex flex-col bg-[var(--bg-deep)]">
      <Header />

      <div className="flex-1 container mx-auto px-8 flex flex-col items-center py-12">
        <div className="w-full max-w-2xl mb-12 flex justify-between relative">
          <div className="absolute top-1/2 left-0 w-full h-[2px] bg-[var(--glass-border)] -z-10" />
          <div
            className="absolute top-1/2 left-0 h-[2px] bg-[var(--accent-neon-violet)] -z-10 transition-all duration-500"
            style={{ width: `${(step - 1) * 50}%` }}
          />

          <StepIndicator currentStep={step} stepNum={1} label={t('setup.progressStep1')} />
          <StepIndicator currentStep={step} stepNum={2} label={t('setup.progressStep2')} />
          <StepIndicator currentStep={step} stepNum={3} label={t('setup.progressStep3')} />
        </div>

        <div className="glass-panel w-full max-w-2xl p-8 min-h-[400px] relative overflow-hidden">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col h-full"
              >
                <h2 className="text-3xl font-bold mb-4">{t('setup.step1Title')}</h2>
                <p className="text-[var(--text-secondary)] mb-8">{t('setup.step1Desc')}</p>

                <div className="flex-1 flex flex-col gap-4">
                  <div className="flex items-center gap-4 bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] focus-within:border-[#7c3aed] transition-colors">
                    <GitBranch className="text-[var(--text-secondary)]" />
                    <input
                      type="text"
                      placeholder={t('setup.placeholderRepo')}
                      className="bg-transparent border-none outline-none flex-1 text-white placeholder:text-[var(--text-secondary)]"
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                    />
                  </div>
                </div>

                <div className="mt-auto flex justify-end">
                  <button
                    onClick={nextStep}
                    disabled={!repo}
                    className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform"
                  >
                    {t('setup.connectBtn')} <ChevronRight size={18} />
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
                className="flex flex-col h-full"
              >
                <h2 className="text-3xl font-bold mb-4">{t('setup.step2Title')}</h2>
                <p className="text-[var(--text-secondary)] mb-8">{t('setup.step2Desc')}</p>

                <div className="flex-1">
                  <textarea
                    placeholder={t('setup.placeholderPrompt')}
                    className="w-full h-48 bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] focus:border-[#7c3aed] outline-none text-white placeholder:text-[var(--text-secondary)] resize-none"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </div>

                <div className="mt-auto flex justify-between">
                  <button
                    onClick={() => setStep(1)}
                    className="text-[var(--text-secondary)] hover:text-white transition-colors px-4 py-2"
                  >
                    Back
                  </button>
                  <button
                    onClick={nextStep}
                    disabled={!prompt}
                    className="bg-[#7c3aed] text-white px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:glow-text hover:scale-105 transition-all"
                  >
                    {t('setup.deployBtn')} <Terminal size={18} />
                  </button>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center justify-center h-full min-h-[300px] text-center"
              >
                <div className="w-20 h-20 bg-[rgba(6,182,212,0.1)] text-[#06b6d4] rounded-full flex items-center justify-center mb-6 glow-border">
                  <CheckCircle2 size={40} />
                </div>
                <h2 className="text-3xl font-bold mb-4">{t('setup.successMsg')}</h2>
                <p className="text-[var(--text-secondary)] mb-8">{t('setup.step3Desc')}</p>

                <Link
                  href="/painel"
                  className="bg-white text-black px-8 py-4 rounded-full font-bold hover:scale-105 transition-transform flex items-center gap-2"
                >
                  {t('nav.dashboard')} <ChevronRight size={18} />
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  )
}

function StepIndicator({
  currentStep,
  stepNum,
  label,
}: {
  currentStep: number
  stepNum: number
  label: string
}) {
  const active = currentStep >= stepNum
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-colors duration-500 ${active ? 'bg-[#7c3aed] text-white glow-border' : 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--glass-border)]'}`}
      >
        {stepNum}
      </div>
      <span
        className={`text-xs font-medium ${active ? 'text-white' : 'text-[var(--text-secondary)]'}`}
      >
        {label}
      </span>
    </div>
  )
}
