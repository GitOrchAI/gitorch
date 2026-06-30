'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'
import { locales } from './locales'

export type Language = 'en' | 'pt' | 'es'

interface LanguageContextProps {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string) => string
}

const LanguageContext = createContext<LanguageContextProps | undefined>(undefined)

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en')

  useEffect(() => {
    const saved = localStorage.getItem('gitorch-lang') as Language
    if (saved && (saved === 'en' || saved === 'pt' || saved === 'es')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved !== language) setLanguageState(saved)
    } else {
      const browserLang = navigator.language.slice(0, 2)
      const detected = browserLang === 'pt' ? 'pt' : browserLang === 'es' ? 'es' : 'en'
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (detected !== language) setLanguageState(detected)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setLanguage = (lang: Language) => {
    setLanguageState(lang)
    localStorage.setItem('gitorch-lang', lang)
  }

  const t = (key: string): string => {
    const keys = key.split('.')
    let current: unknown = locales[language]

    for (const k of keys) {
      if (current && typeof current === 'object' && k in current) {
        current = (current as Record<string, unknown>)[k]
      } else {
        // Fallback to English
        let fallback: unknown = locales['en']
        for (const fk of keys) {
          if (fallback && typeof fallback === 'object' && fk in fallback) {
            fallback = (fallback as Record<string, unknown>)[fk]
          } else {
            return key // return key if not found anywhere
          }
        }
        return typeof fallback === 'string' ? fallback : key
      }
    }

    return typeof current === 'string' ? current : key
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export const useLanguage = () => {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
