import React from 'react'
import { ChevronRight, Check, Cpu, Terminal, Sparkles } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

interface StepSelectEnginesProps {
  selectedEngines: string[]
  setSelectedEngines: (engines: string[]) => void
  onNext: () => void
  onBack: () => void
}

// Os 3 motores são IGUAIS (regra do plano). id = vocabulário do wizard
// ('claude-code' → runtime 'claude' no backend). Nome é próprio; descrição i18n.
const ENGINES = [
  { id: 'claude-code', name: 'Claude Code', descKey: 'setup.engClaudeDesc', Icon: Cpu },
  { id: 'codex', name: 'Codex', descKey: 'setup.engCodexDesc', Icon: Sparkles },
  { id: 'antigravity', name: 'Antigravity', descKey: 'setup.engAntigravityDesc', Icon: Terminal },
] as const

export default function StepSelectEngines({
  selectedEngines,
  setSelectedEngines,
  onNext,
  onBack,
}: StepSelectEnginesProps) {
  const { t } = useLanguage()

  const toggleEngine = (engine: string) => {
    if (selectedEngines.includes(engine)) {
      setSelectedEngines(selectedEngines.filter((e) => e !== engine))
    } else {
      setSelectedEngines([...selectedEngines, engine])
    }
  }

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.enginesTitle')}</h2>
      <p className="wz-sub">{t('setup.enginesDesc')}</p>

      <div className="wz-body space-y-3">
        {ENGINES.map(({ id, name, descKey, Icon }) => {
          const selected = selectedEngines.includes(id)
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggleEngine(id)}
              className={`wz-opt${selected ? ' is-selected' : ''}`}
            >
              <div className="flex items-start gap-3">
                <Icon
                  size={20}
                  style={{ color: 'var(--gl-accent-ink)', flex: 'none', marginTop: 2 }}
                />
                <div>
                  <div className="wz-opt-title">{name}</div>
                  <p className="wz-opt-desc">{t(descKey)}</p>
                </div>
              </div>
              {selected && (
                <span className="wz-ok" style={{ flex: 'none' }}>
                  <Check size={16} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button
          onClick={onNext}
          disabled={selectedEngines.length === 0}
          className="wz-btn wz-btn-primary"
        >
          {t('setup.next')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
