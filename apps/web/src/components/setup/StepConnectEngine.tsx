import React, { useEffect, useMemo } from 'react'
import { ChevronRight, Check, Cpu, Sparkles, Terminal } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import { hasUsageWindowData, formatClaudeUsage, type LoginState } from './engine-status'
import { useConexaoDeMotores } from './useConexaoDeMotores'
import { ControlesDeConexao } from './ControlesDeConexao'
import { ESTILO_DO_ASSISTENTE, textosDoAssistente } from './conexao-textos'

interface StepConnectEngineProps {
  apiBaseUrl: string
  selectedEngines: string[]
  onNext: () => void
  onBack: () => void
}

const ENGINES = [
  { id: 'claude-code', runtime: 'claude', name: 'Claude Code', Icon: Cpu },
  { id: 'codex', runtime: 'codex', name: 'Codex', Icon: Sparkles },
  { id: 'antigravity', runtime: 'antigravity', name: 'Antigravity', Icon: Terminal },
] as const

export default function StepConnectEngine({
  apiBaseUrl,
  selectedEngines,
  onNext,
  onBack,
}: StepConnectEngineProps) {
  const { t } = useLanguage()
  const cards = useMemo(
    () => ENGINES.filter((e) => selectedEngines.includes(e.id)),
    [selectedEngines]
  )

  // O FLUXO inteiro (start -> stream -> código -> token -> refetch) mora em
  // conexao-de-motor.ts, e é o MESMO que o painel usa para religar um motor
  // sem sair da tela em que o dono está. Este passo deixou de ser o único
  // lugar do produto que conecta motor.
  const { estados, enviandoToken, conexao } = useConexaoDeMotores(
    apiBaseUrl,
    t('setup.connectError')
  )
  const textos = textosDoAssistente(t)

  // Estado real do servidor: motores já conectados aparecem como conectados.
  useEffect(() => {
    void conexao.carregarDoServidor(ENGINES.map(({ id, runtime }) => ({ id, runtime })))
  }, [conexao])

  const anyConnected = cards.some((c) => estados[c.id]?.phase === 'connected')

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.connectTitle')}</h2>
      <p className="wz-sub">{t('setup.connectDesc')}</p>

      <div className="wz-body space-y-4 overflow-y-auto" style={{ maxHeight: '18rem' }}>
        {cards.map(({ id, runtime, name, Icon }) => {
          const state: LoginState = estados[id] ?? { phase: 'idle' }
          const isConnected = state.phase === 'connected'
          return (
            <div
              key={id}
              className="rounded-2xl p-5"
              style={{
                background: 'var(--gl-canvas)',
                border: `1px solid ${isConnected ? 'var(--gl-accent)' : 'var(--gl-hair)'}`,
                boxShadow: isConnected ? '0 0 0 3px var(--gl-accent-soft)' : 'none',
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="wz-opt-title flex items-center gap-2">
                  <Icon size={18} style={{ color: 'var(--gl-accent-ink)' }} /> {name}
                </span>
                {isConnected && (
                  <span className="wz-ok">
                    <Check size={16} /> {t('setup.connectedLabel')}
                  </span>
                )}
              </div>

              {/* Motor VIVO: mostra que respondeu de verdade — os NOMES dos
                  modelos (não uma contagem) e a quota real. Os 3 motores
                  expõem a quota como % usado de sessão/semana (Claude via API,
                  Codex via rate_limits, Antigravity via /usage) — ver
                  quota-reader.ts no control-plane. hasUsageWindowData/
                  formatClaudeUsage mostram ESSE dado real pra QUALQUER motor
                  (21/07: antes era gated só no Claude, então o Codex/Antigravity
                  não mostravam a quota mesmo tendo o dado). */}
              {state.phase === 'connected' &&
                (state.models != null || state.quota != null || hasUsageWindowData(state)) && (
                  <p className="wz-opt-desc" style={{ fontSize: '0.78rem' }}>
                    {[
                      state.models != null && state.models.length > 0
                        ? `${t('setup.connectModelsLabel')}: ${state.models.join(', ')}`
                        : null,
                      state.quota != null
                        ? `${t('setup.connectQuotaLabel')}: ${state.quota}`
                        : null,
                      hasUsageWindowData(state)
                        ? formatClaudeUsage(state, {
                            session: t('setup.connectClaudeSessionLabel'),
                            week: t('setup.connectClaudeWeekLabel'),
                            used: t('setup.connectClaudeUsedLabel'),
                            resets: t('setup.connectClaudeResetsLabel'),
                          })
                        : null,
                    ]
                      .filter((part): part is string => !!part)
                      .join(' · ')}
                  </p>
                )}

              <ControlesDeConexao
                conexao={conexao}
                id={id}
                runtime={runtime}
                estado={state}
                enviandoToken={!!enviandoToken[id]}
                textos={textos}
                estilo={ESTILO_DO_ASSISTENTE}
              />
            </div>
          )
        })}
      </div>

      {!anyConnected && (
        <p className="wz-opt-desc" style={{ marginTop: 12 }}>
          {t('setup.connectGate')}
        </p>
      )}

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button onClick={onNext} disabled={!anyConnected} className="wz-btn wz-btn-primary">
          {t('setup.next')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
