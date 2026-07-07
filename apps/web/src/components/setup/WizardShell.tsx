'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { useLanguage, Language } from '../../LanguageContext'

const LANGS: Language[] = ['en', 'pt', 'es']

// Mesma marca da landing (design system .gl). Mantida local para o wizard não
// depender do Header antigo (violeta), que a landing também não usa.
const Mark = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="12" r="2.4" />
    <path d="M6 8.4v7.2M8 6h4.6a3 3 0 0 1 3 3v0M8 18h4.6a3 3 0 0 0 3-3v0" />
  </svg>
)

/**
 * Casca do wizard no MESMO design system .gl da landing (verde, claro+escuro).
 * O tema vive em estado local (default = preferência do sistema via CSS; o
 * toggle o torna explícito por data-theme), idêntico ao comportamento da
 * landing. Idioma vem do LanguageContext compartilhado (pt/en/es).
 */
export default function WizardShell({ children }: { children: React.ReactNode }) {
  const { language, setLanguage } = useLanguage()
  const [theme, setTheme] = useState<'dark' | 'light' | null>(null)

  const toggleTheme = () => {
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    const current = theme ?? (prefersDark ? 'dark' : 'light')
    setTheme(current === 'dark' ? 'light' : 'dark')
  }

  const cycleLanguage = () => {
    const i = LANGS.indexOf(language)
    setLanguage(LANGS[(i + 1) % LANGS.length] as Language)
  }

  return (
    <div className="gl" data-theme={theme ?? undefined}>
      <header className="gl-nav">
        <div className="gl-container gl-nav-inner">
          <Link className="gl-brand" href="/" aria-label="GitOrch">
            <span className="gl-mark" aria-hidden="true">
              <Mark />
            </span>
            GitOrch
          </Link>
          <div className="gl-nav-right">
            <button className="gl-lang" onClick={cycleLanguage} aria-label="Idioma">
              {language.toUpperCase()}
            </button>
            <button
              className="gl-toggle"
              onClick={toggleTheme}
              aria-label="Tema claro/escuro"
              title="Tema"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}
