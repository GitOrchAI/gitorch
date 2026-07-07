'use client'
/* eslint-disable */
import React, { createContext, useContext, useState, useEffect } from 'react'
import { locales } from './locales'

export type Language = 'en' | 'pt' | 'es'

interface LanguageContextProps {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextProps | undefined>(undefined)

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en')

  useEffect(() => {
    // Detect browser language on first render
    const saved =
      typeof window !== 'undefined' ? (localStorage.getItem('gitorch-lang') as Language) : null
    if (saved && (saved === 'en' || saved === 'pt' || saved === 'es')) {
      if (saved !== language) {
        setLanguageState(saved)
      }
    } else if (typeof window !== 'undefined') {
      const browserLang = navigator.language.slice(0, 2)
      let detected: Language = 'en'
      if (browserLang === 'pt') {
        detected = 'pt'
      } else if (browserLang === 'es') {
        detected = 'es'
      }

      if (detected !== language) {
        setLanguageState(detected)
      }
    }
  }, [language])

  const setLanguage = (lang: Language) => {
    setLanguageState(lang)
    localStorage.setItem('gitorch-lang', lang)
  }

  // Interpolação simples {{var}} — só usada por telas que passam `vars`
  // (ex.: achados do diagnóstico com números reais). Chamadas antigas t(key)
  // continuam idênticas (vars undefined -> nenhum replace).
  const interpolate = (s: string, vars?: Record<string, string | number>): string => {
    if (!vars) return s
    return s.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    )
  }

  const t = (key: string, vars?: Record<string, string | number>): string => {
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
        return typeof fallback === 'string' ? interpolate(fallback, vars) : key
      }
    }

    return typeof current === 'string' ? interpolate(current, vars) : key
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
