import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Loader2, Send } from 'lucide-react'
import { useLanguage } from '../../LanguageContext'
import {
  readTelegramLink,
  startTelegramLink,
  TELEGRAM_BENEFIT_KEYS,
  type TelegramLinkState,
} from './telegram-link'

interface StepTelegramProps {
  apiBaseUrl: string
  onNext: () => void
  onBack: () => void
}

// Cadência do polling: rápido o bastante para o ✓ aparecer logo depois do Start,
// devagar o bastante para caber no teto da rota (60/min).
const POLL_MS = 2500

/**
 * Passo do Telegram — OPCIONAL, e agora VERDADEIRO.
 *
 * O que este passo era: um link para o bot e um campo de @username guardado em
 * estado local. Zero backend. E não havia backend que salvasse: a API do
 * Telegram só entrega mensagem a quem já falou com o bot, endereçando por
 * `chat_id` — um @username de pessoa não endereça nada. O cliente informava o
 * Telegram dele e nunca receberia mensagem nenhuma.
 *
 * O que este passo é: o backend gera um token e devolve o deep link
 * `t.me/<bot>?start=<token>`; o cliente abre e aperta Start; o bot recebe
 * `/start <token>` e é ali que o `chat_id` nasce e é vinculado ao dono. Esta
 * tela só mostra ✓ quando o BACKEND confirma o vínculo — enquanto isso, ela diz
 * exatamente o que está acontecendo ("aperte Start; estamos esperando").
 */
export default function StepTelegram({ apiBaseUrl, onNext, onBack }: StepTelegramProps) {
  const { t } = useLanguage()
  const [state, setState] = useState<TelegramLinkState>({ phase: 'idle' })
  const [connecting, setConnecting] = useState(false)

  // Já vinculado (reabriu o wizard)? A tela nasce dizendo a verdade.
  useEffect(() => {
    let cancelled = false
    void readTelegramLink({ apiBaseUrl, fallbackError: t('setup.tgError') }).then((next) => {
      if (!cancelled && next && next.phase === 'linked') setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, t])

  // Enquanto pendente, pergunta ao backend se o Start já chegou. Só ele sabe —
  // abrir o Telegram não prova nada, e este passo não inventa sucesso.
  useEffect(() => {
    if (state.phase !== 'pending') return
    let cancelled = false
    const id = setInterval(() => {
      void readTelegramLink({ apiBaseUrl, fallbackError: t('setup.tgError') }).then((next) => {
        // `null` = o poll não respondeu (rede/429): mantém o estado, não assusta.
        if (cancelled || !next) return
        if (next.phase === 'linked') setState(next)
      })
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [state.phase, apiBaseUrl, t])

  const handleConnect = useCallback(async () => {
    setConnecting(true)
    const next = await startTelegramLink({ apiBaseUrl, fallbackError: t('setup.tgError') })
    setConnecting(false)
    setState(next)
    // Abre o Telegram no próprio gesto do clique (popup blocker respeita isso).
    if (next.phase === 'pending') window.open(next.deepLink, '_blank', 'noopener,noreferrer')
  }, [apiBaseUrl, t])

  const linked = state.phase === 'linked'

  return (
    <div className="flex flex-col h-full">
      <h2 className="wz-h">{t('setup.tgTitle')}</h2>
      <p className="wz-sub">{t('setup.tgDesc')}</p>

      <div className="wz-body space-y-4">
        {/* PRA QUE serve o Telegram — o passo antigo pedia o contato sem nunca
            dizer o motivo. Fica acima do botão, some quando já vinculado. */}
        {!linked && (
          <ul className="space-y-1.5" style={{ fontSize: '0.78rem', color: 'var(--gl-muted)' }}>
            {TELEGRAM_BENEFIT_KEYS.map((key) => (
              <li key={key}>✓ {t(key)}</li>
            ))}
          </ul>
        )}

        {!linked && (
          <button
            onClick={() => void handleConnect()}
            disabled={connecting}
            className="wz-btn wz-btn-primary"
            style={{ width: 'fit-content' }}
          >
            {connecting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {state.phase === 'error' ? t('setup.tgRetry') : t('setup.tgConnect')}
          </button>
        )}

        {/* Pendente NÃO é sucesso: o texto diz o que falta (apertar Start). */}
        {state.phase === 'pending' && (
          <div className="flex items-center gap-2 wz-opt-desc">
            <Loader2 size={16} className="animate-spin" />
            <span>{t('setup.tgWaiting')}</span>
          </div>
        )}

        {linked && (
          // Vínculo confirmado = mesmo verde de sucesso do resto do funil
          // (wz-ok, usado em StepConnectEngine/StepSelectRepos/StepReady) — antes
          // ficava na cor de texto padrão (wz-opt-title), sem sinalizar sucesso.
          <div className="flex items-center gap-2 wz-ok" style={{ fontSize: '0.9rem' }}>
            <Check size={16} />
            <span>{t('setup.tgLinked')}</span>
          </div>
        )}

        {state.phase === 'error' && (
          // Mensagem de erro real precisa de --gl-sev (wz-err), igual a todo
          // outro erro do funil — usava wz-opt-desc (cinza neutro), o mesmo
          // padrão de bug que reabriu esta task.
          <div className="flex items-center gap-2 wz-err">
            <AlertCircle size={16} />
            <span>{state.message}</span>
          </div>
        )}

        <p className="wz-opt-desc">{t('setup.tgOptional')}</p>
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
