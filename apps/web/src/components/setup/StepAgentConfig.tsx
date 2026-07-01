import React from 'react'
import { ChevronRight, Settings } from 'lucide-react'

interface AutonomyLevels {
  sm: number
  qa: number
  ra: number
  po: number
}

interface StepAgentConfigProps {
  telegram: string
  setTelegram: (username: string) => void
  autonomy: AutonomyLevels
  setAutonomy: (levels: AutonomyLevels) => void
  onNext: () => void
  onBack: () => void
}

export default function StepAgentConfig({
  telegram,
  setTelegram,
  autonomy,
  setAutonomy,
  onNext,
  onBack,
}: StepAgentConfigProps) {
  const handleRangeChange = (agent: keyof AutonomyLevels, val: number) => {
    setAutonomy({
      ...autonomy,
      [agent]: val,
    })
  }

  const getLabel = (val: number) => {
    if (val <= 2) return 'Baixo (Apenas Leitura)'
    if (val <= 4) return 'Médio (Sugere PRs)'
    return 'Alto (Merge Autônomo)'
  }

  return (
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Configurações de Autonomia</h2>
      <p className="text-[var(--text-secondary)] mb-6">
        Defina os canais de alertas e até que ponto os agentes inteligentes podem agir sozinhos.
      </p>

      <div className="flex-1 space-y-5 overflow-y-auto max-h-[280px] pr-1">
        {/* Telegram Input */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-bold text-white">Username do Telegram</label>
          <input
            type="text"
            placeholder="@seu_usuario"
            value={telegram}
            onChange={(e) => setTelegram(e.target.value)}
            className="bg-[var(--bg-surface-elevated)] px-4 py-3 rounded-xl border border-[var(--glass-border)] outline-none text-white focus:border-[#7c3aed] text-sm"
          />
          <p className="text-[10px] text-[var(--text-secondary)]">
            Usado para receber alertas em tempo real quando os runners terminarem ou falharem.
          </p>
        </div>

        {/* Sliders for Autonomy */}
        <div className="space-y-4 pt-2">
          <h4 className="text-sm font-bold text-white border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
            <Settings size={16} /> Níveis de Autonomia dos Agentes
          </h4>

          {/* Scrum Master */}
          <div className="flex flex-col gap-1.5 bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)]">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-white">Scrum Master (SM)</span>
              <span className="text-[#7c3aed]">{getLabel(autonomy.sm)}</span>
            </div>
            <input
              type="range"
              min="1"
              max="5"
              value={autonomy.sm}
              onChange={(e) => handleRangeChange('sm', parseInt(e.target.value, 10))}
              className="w-full accent-[#7c3aed] h-1 bg-[var(--glass-border)] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Quality Assurance */}
          <div className="flex flex-col gap-1.5 bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)]">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-white">Quality Assurance (QA)</span>
              <span className="text-[#06b6d4]">{getLabel(autonomy.qa)}</span>
            </div>
            <input
              type="range"
              min="1"
              max="5"
              value={autonomy.qa}
              onChange={(e) => handleRangeChange('qa', parseInt(e.target.value, 10))}
              className="w-full accent-[#06b6d4] h-1 bg-[var(--glass-border)] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Requirements Analyst */}
          <div className="flex flex-col gap-1.5 bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)]">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-white">Requirements Analyst (RA)</span>
              <span className="text-[#f472b6]">{getLabel(autonomy.ra)}</span>
            </div>
            <input
              type="range"
              min="1"
              max="5"
              value={autonomy.ra}
              onChange={(e) => handleRangeChange('ra', parseInt(e.target.value, 10))}
              className="w-full accent-[#f472b6] h-1 bg-[var(--glass-border)] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Product Owner */}
          <div className="flex flex-col gap-1.5 bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)]">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-white">Product Owner (PO)</span>
              <span className="text-[#10b981]">{getLabel(autonomy.po)}</span>
            </div>
            <input
              type="range"
              min="1"
              max="5"
              value={autonomy.po}
              onChange={(e) => handleRangeChange('po', parseInt(e.target.value, 10))}
              className="w-full accent-[#10b981] h-1 bg-[var(--glass-border)] rounded-lg appearance-none cursor-pointer"
            />
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
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 hover:scale-105 transition-transform cursor-pointer"
        >
          Avançar <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
