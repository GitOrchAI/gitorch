import React from 'react'
import { useLanguage } from '../../LanguageContext'

interface StepGitHubLoginProps {
  apiBaseUrl: string
}

export default function StepGitHubLogin({ apiBaseUrl }: StepGitHubLoginProps) {
  const { t } = useLanguage()
  const handleLogin = () => {
    // Diz à API de onde viemos, para o login devolver a pessoa a ESTA origem —
    // o wizard roda tanto no site publicado quanto servido pela própria API
    // (same-origin). Sem isso o retorno era fixo e jogava quem entrasse pelo
    // segundo caminho para fora do wizard, com a sessão órfã em outro domínio.
    // A API valida este valor contra uma allowlist (não é destino livre).
    const base = window.location.href.split('/setup')[0]
    const returnTo = encodeURIComponent(base)
    window.location.href = `${apiBaseUrl}/api/v1/auth/github?return_to=${returnTo}`
  }

  return (
    <div className="wz-body flex flex-col items-center justify-center text-center">
      <div
        className="mb-6 flex h-16 w-16 items-center justify-center rounded-full"
        style={{ background: 'var(--gl-accent-soft)', color: 'var(--gl-accent-ink)' }}
      >
        <svg
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
      </div>

      <h2 className="wz-h">{t('setup.githubTitle')}</h2>
      <p className="wz-sub" style={{ maxWidth: '28rem' }}>
        {t('setup.githubDesc')}
      </p>

      <button onClick={handleLogin} className="wz-btn wz-btn-primary">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.197 22 16.442 22 12.017 22 6.484 17.522 2 12 2z"
          />
        </svg>
        {t('setup.githubBtn')}
      </button>
    </div>
  )
}
