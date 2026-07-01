import React from 'react'
import { ChevronRight, Terminal, Cpu } from 'lucide-react'

interface StepSelectEnginesProps {
  selectedEngines: string[]
  setSelectedEngines: (engines: string[]) => void
  onNext: () => void
  onBack: () => void
}

export default function StepSelectEngines({
  selectedEngines,
  setSelectedEngines,
  onNext,
  onBack,
}: StepSelectEnginesProps) {
  const toggleEngine = (engine: string) => {
    if (selectedEngines.includes(engine)) {
      setSelectedEngines(selectedEngines.filter((e) => e !== engine))
    } else {
      setSelectedEngines([...selectedEngines, engine])
    }
  }

  return (
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Escolha seus Motores</h2>
      <p className="text-[var(--text-secondary)] mb-8">
        Selecione quais inteligências artificiais e runtimes atuarão no seu repositório.
      </p>

      <div className="flex-1 space-y-4">
        {/* Claude Code */}
        <div
          onClick={() => toggleEngine('claude-code')}
          className={`flex items-start gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${
            selectedEngines.includes('claude-code')
              ? 'bg-[rgba(124,58,237,0.05)] border-[#7c3aed]'
              : 'bg-[var(--bg-surface-elevated)] border-[var(--glass-border)] hover:border-[#ffffff20]'
          }`}
        >
          <input
            type="checkbox"
            checked={selectedEngines.includes('claude-code')}
            onChange={() => {}} // Handle via parent click
            className="w-5 h-5 mt-1 rounded border-[var(--glass-border)] text-[#7c3aed] focus:ring-[#7c3aed] bg-transparent pointer-events-none"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="text-[#06b6d4]" size={20} />
              <span className="font-bold text-white">Claude Code</span>
            </div>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
              O motor de agente oficial da Anthropic para o terminal. Ideal para refatorações
              profundas, execuções de comandos locais e investigações de bugs complexos diretamente
              na branch de trabalho.
            </p>
          </div>
        </div>

        {/* Antigravity CLI */}
        <div
          onClick={() => toggleEngine('antigravity')}
          className={`flex items-start gap-4 p-5 rounded-2xl border transition-all cursor-pointer ${
            selectedEngines.includes('antigravity')
              ? 'bg-[rgba(124,58,237,0.05)] border-[#7c3aed]'
              : 'bg-[var(--bg-surface-elevated)] border-[var(--glass-border)] hover:border-[#ffffff20]'
          }`}
        >
          <input
            type="checkbox"
            checked={selectedEngines.includes('antigravity')}
            onChange={() => {}} // Handle via parent click
            className="w-5 h-5 mt-1 rounded border-[var(--glass-border)] text-[#7c3aed] focus:ring-[#7c3aed] bg-transparent pointer-events-none"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Terminal className="text-[#f472b6]" size={20} />
              <span className="font-bold text-white">Antigravity CLI</span>
            </div>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
              Nosso próprio motor e CLI de automação. Executa em segundo plano orchestrando
              workflows completos no monorepo e integrando diretamente com as APIs de telemetria e o
              Control Plane.
            </p>
          </div>
        </div>
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
          disabled={selectedEngines.length === 0}
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform cursor-pointer"
        >
          Avançar <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
