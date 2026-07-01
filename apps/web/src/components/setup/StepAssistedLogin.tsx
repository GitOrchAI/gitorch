import React, { useState } from 'react'
import { ChevronRight, Key, ShieldCheck, Loader2 } from 'lucide-react'

interface StepAssistedLoginProps {
  selectedEngines: string[]
  onNext: () => void
  onBack: () => void
}

export default function StepAssistedLogin({
  selectedEngines,
  onNext,
  onBack,
}: StepAssistedLoginProps) {
  const [authorizedClaude, setAuthorizedClaude] = useState(false)
  const [authorizedAnti, setAuthorizedAnti] = useState(false)
  const [authenticatingClaude, setAuthenticatingClaude] = useState(false)
  const [authenticatingAnti, setAuthenticatingAnti] = useState(false)

  const hasClaude = selectedEngines.includes('claude-code')
  const hasAnti = selectedEngines.includes('antigravity')

  const handleClaudeAuth = () => {
    setAuthenticatingClaude(true)
    // Simulate OAuth callback capture via local loopback port
    setTimeout(() => {
      setAuthenticatingClaude(false)
      setAuthorizedClaude(true)
    }, 2000)
  }

  const handleAntiAuth = () => {
    setAuthenticatingAnti(true)
    // Simulate OAuth loopback capture
    setTimeout(() => {
      setAuthenticatingAnti(false)
      setAuthorizedAnti(true)
    }, 2000)
  }

  const canContinue = (!hasClaude || authorizedClaude) && (!hasAnti || authorizedAnti)

  return (
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Login Assistido nos Motores</h2>
      <p className="text-[var(--text-secondary)] mb-8">
        Para que os motores consigam rodar tarefas automaticamente no terminal isolado, autorize as
        runtimes via OAuth Loopback local.
      </p>

      <div className="flex-1 space-y-6">
        {hasClaude && (
          <div className="bg-[var(--bg-surface-elevated)] p-5 rounded-2xl border border-[var(--glass-border)] flex items-center justify-between">
            <div>
              <h4 className="font-bold text-white mb-1 flex items-center gap-2">
                <Key className="text-[#06b6d4]" size={18} /> Autenticar Claude Code CLI
              </h4>
              <p className="text-xs text-[var(--text-secondary)] max-w-md">
                O sistema abrirá uma porta local loopback em seu sistema para capturar a chave de
                sessão de forma segura.
              </p>
            </div>

            {authorizedClaude ? (
              <span className="text-sm font-bold text-[#10b981] flex items-center gap-1">
                <ShieldCheck size={18} /> Autorizado
              </span>
            ) : (
              <button
                onClick={handleClaudeAuth}
                disabled={authenticatingClaude}
                className="bg-white text-black text-sm px-4 py-2.5 rounded-full font-bold flex items-center gap-2 cursor-pointer hover:scale-105 transition-transform"
              >
                {authenticatingClaude ? (
                  <>
                    <Loader2 className="animate-spin" size={14} /> Aguardando...
                  </>
                ) : (
                  'Autorizar'
                )}
              </button>
            )}
          </div>
        )}

        {hasAnti && (
          <div className="bg-[var(--bg-surface-elevated)] p-5 rounded-2xl border border-[var(--glass-border)] flex items-center justify-between">
            <div>
              <h4 className="font-bold text-white mb-1 flex items-center gap-2">
                <Key className="text-[#f472b6]" size={18} /> Autenticar Antigravity CLI
              </h4>
              <p className="text-xs text-[var(--text-secondary)] max-w-md">
                Conecte seu terminal com o cofre do control plane local para sync de telemetrias.
              </p>
            </div>

            {authorizedAnti ? (
              <span className="text-sm font-bold text-[#10b981] flex items-center gap-1">
                <ShieldCheck size={18} /> Autorizado
              </span>
            ) : (
              <button
                onClick={handleAntiAuth}
                disabled={authenticatingAnti}
                className="bg-white text-black text-sm px-4 py-2.5 rounded-full font-bold flex items-center gap-2 cursor-pointer hover:scale-105 transition-transform"
              >
                {authenticatingAnti ? (
                  <>
                    <Loader2 className="animate-spin" size={14} /> Aguardando...
                  </>
                ) : (
                  'Autorizar'
                )}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-auto flex justify-between pt-6">
        <button
          onClick={onBack}
          className="text-[var(--text-secondary)] hover:text-white transition-colors px-4 py-2"
        >
          Voltar
        </button>
        <button
          onClick={onNext}
          disabled={!canContinue}
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform cursor-pointer"
        >
          Avançar <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
