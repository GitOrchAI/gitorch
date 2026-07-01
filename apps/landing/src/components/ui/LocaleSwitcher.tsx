import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Globe } from 'lucide-react'
import { useState } from 'react'

interface LocaleSwitcherProps {
  className?: string
}

export function LocaleSwitcher({ className }: LocaleSwitcherProps) {
  const { i18n } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  const languages = [
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'pt-BR', label: 'Português', flag: '🇧🇷' },
    { code: 'es', label: 'Español', flag: '🇪🇸' },
  ] as const

  const currentLang = languages.find((l) => l.code === i18n.language) || languages[0]

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng)
    setIsOpen(false)
  }

  return (
    <div className={cn('relative', className)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg',
          'bg-white/10 dark:bg-dark-800/50',
          'border border-white/10 dark:border-dark-700',
          'hover:bg-white/20 dark:hover:bg-dark-700',
          'text-sm font-medium text-dark-100 dark:text-dark-50',
          'transition-all duration-200'
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <Globe className="w-4 h-4" />
        <span>
          {currentLang.flag} {currentLang.label}
        </span>
        <svg
          className={cn('w-4 h-4 transition-transform', isOpen && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} aria-hidden="true" />
          <ul
            className={cn(
              'absolute right-0 mt-2 w-40 z-50',
              'bg-white dark:bg-dark-800',
              'border border-white/10 dark:border-dark-700',
              'rounded-lg shadow-lg overflow-hidden',
              'animate-slide-down'
            )}
            role="listbox"
          >
            {languages.map((lang) => (
              <li key={lang.code} role="option" aria-selected={i18n.language === lang.code}>
                <button
                  onClick={() => changeLanguage(lang.code)}
                  className={cn(
                    'w-full px-4 py-2.5 text-left',
                    'flex items-center gap-3',
                    'text-sm font-medium',
                    'hover:bg-dark-100 dark:hover:bg-dark-700',
                    'transition-colors',
                    i18n.language === lang.code
                      ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20'
                      : 'text-dark-700 dark:text-dark-300'
                  )}
                >
                  <span>{lang.flag}</span>
                  <span>{lang.label}</span>
                  {i18n.language === lang.code && (
                    <svg
                      className="ml-auto w-4 h-4 text-primary-600 dark:text-primary-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
