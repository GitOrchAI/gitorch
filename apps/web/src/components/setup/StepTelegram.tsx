import React from 'react'
import { ChevronRight, Send } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'

interface StepTelegramProps {
  telegram: string
  setTelegram: (username: string) => void
  onNext: () => void
  onBack: () => void
}

// Bot configurável (produto dinâmico, nunca hardcoded por ambiente). Sem env,
// cai no bot público conhecido.
const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT ?? 'GitOrchAI_bot'

/**
 * Passo do Telegram: OPCIONAL e amigável para leigos. Abre o bot de verdade
 * (deep-link) e captura o @username opcional que o setup/submit já aceita.
 * Sem estado falso de "conectado por polling" — não há binding automático de
 * chat_id no backend hoje (isso é um follow-up que exige o bot ao vivo).
 */
export default function StepTelegram({ telegram, setTelegram, onNext, onBack }: StepTelegramProps) {
  const { t } = useLanguage()

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.tgTitle')}</h2>
      <p className="wz-sub">{t('setup.tgDesc')}</p>

      <div className="wz-body space-y-4">
        <a
          href={`https://t.me/${BOT}`}
          target="_blank"
          rel="noreferrer"
          className="wz-btn wz-btn-primary"
          style={{ width: 'fit-content' }}
        >
          <Send size={16} /> {t('setup.tgOpen')}
        </a>

        <div className="flex flex-col gap-2">
          <label className="wz-opt-title" style={{ fontSize: '0.9rem' }}>
            {t('setup.tgHandleLabel')}
          </label>
          <input
            type="text"
            className="wz-field"
            placeholder={t('setup.tgHandlePlaceholder')}
            value={telegram}
            onChange={(e) => setTelegram(e.target.value)}
          />
          <p className="wz-opt-desc">{t('setup.tgHandleHint')}</p>
        </div>
      </div>

      <div className="wz-actions">
        <button onClick={onBack} className="wz-btn wz-btn-ghost">
          {t('setup.back')}
        </button>
        <button onClick={onNext} className="wz-btn wz-btn-primary">
          {t('setup.next')} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
