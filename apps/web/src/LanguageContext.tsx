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
    // Detect browser language on first render
    const saved = localStorage.getItem('gitorch-lang') as Language
    if (saved && (saved === 'en' || saved === 'pt' || saved === 'es')) {
      setLanguageState(saved)
    } else {
      const browserLang = navigator.language.slice(0, 2)
      if (browserLang === 'pt') {
        setLanguageState('pt')
      } else if (browserLang === 'es') {
        setLanguageState('es')
      } else {
        setLanguageState('en')
      }
    }
  }, [])

  const setLanguage = (lang: Language) => {
    setLanguageState(lang)
    localStorage.setItem('gitorch-lang', lang)
  }

  const t = (key: string): string => {
    const keys = key.split('.')
    let current: Record<string, unknown> = locales[language] as Record<string, unknown>

    for (const k of keys) {
      if (current && current[k] !== undefined) {
        current = current[k] as Record<string, unknown>
      } else {
        // Fallback to English
        let fallback: Record<string, unknown> = locales['en'] as Record<string, unknown>
        for (const fk of keys) {
          if (fallback && fallback[fk] !== undefined) {
            fallback = fallback[fk] as Record<string, unknown>
          } else {
            return key // return key if not found anywhere
          }
        }
        return fallback
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
