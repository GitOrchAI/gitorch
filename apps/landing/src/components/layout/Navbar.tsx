import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { LocaleSwitcher } from './LocaleSwitcher'
import { GitHubStars } from './GitHubStars'
import { AuthModal } from './AuthModal'

interface NavbarProps {
  className?: string
}

export function Navbar({ className }: NavbarProps) {
  const { t } = useTranslation()
  const [isAuthOpen, setIsAuthOpen] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  const navLinks = [
    { href: '#features', label: t('nav.product') },
    { href: '#demo', label: t('nav.demo') },
    { href: '#pricing', label: t('nav.pricing') },
  ]

  return (
    <nav
      className={cn(
        'fixed top-0 left-0 right-0 z-50',
        'bg-white/80 dark:bg-dark-950/80',
        'backdrop-blur-lg',
        'border-b border-white/10 dark:border-dark-800',
        'transition-all duration-300',
        className
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <svg className="w-8 h-8" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect
                width="32"
                height="32"
                rx="8"
                fill="currentColor"
                className="text-primary-600"
              />
              <path
                d="M8 16L14 22L24 10"
                stroke="white"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span className="text-xl font-bold text-dark-900 dark:text-white">{t('nav.logo')}</span>
            <span
              className={cn(
                'px-2 py-0.5 text-xs font-medium rounded-full',
                'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
              )}
            >
              {t('nav.badge')}
            </span>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={cn(
                  'text-sm font-medium text-dark-600 dark:text-dark-300',
                  'hover:text-primary-600 dark:hover:text-primary-400',
                  'transition-colors duration-200'
                )}
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Right Side: Stars, Locale, Auth */}
          <div className="flex items-center gap-4">
            {/* GitHub Stars */}
            <GitHubStars className="hidden sm:flex" />

            {/* Locale Switcher */}
            <LocaleSwitcher />

            {/* Auth Buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsAuthOpen(true)}
                className={cn(
                  'px-4 py-2 text-sm font-medium rounded-lg',
                  'text-dark-600 dark:text-dark-300',
                  'hover:bg-dark-100 dark:hover:bg-dark-800',
                  'transition-colors'
                )}
              >
                {t('nav.login')}
              </button>
              <button
                onClick={() => setIsAuthOpen(true)}
                className={cn(
                  'flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg',
                  'bg-primary-600 text-white',
                  'hover:bg-primary-700',
                  'shadow-lg shadow-primary-600/25',
                  'transition-all duration-200'
                )}
              >
                <Sparkles className="w-4 h-4" />
                {t('nav.cta')}
              </button>
            </div>

            {/* Mobile Menu Button */}
            <button
              className="md:hidden p-2 rounded-lg text-dark-600 dark:text-dark-300 hover:bg-dark-100 dark:hover:bg-dark-800"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-expanded={isMobileMenuOpen}
              aria-controls="mobile-menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isMobileMenuOpen ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Menu */}
        {isMobileMenuOpen && (
          <div
            id="mobile-menu"
            className="md:hidden py-4 border-t border-white/10 dark:border-dark-800 animate-slide-down"
          >
            <div className="flex flex-col gap-4">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-base font-medium text-dark-600 dark:text-dark-300 hover:text-primary-600 dark:hover:text-primary-400"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  {link.label}
                </a>
              ))}
              <div className="flex flex-col gap-2 pt-4 border-t border-white/10 dark:border-dark-800">
                <GitHubStars />
                <LocaleSwitcher />
                <button
                  onClick={() => {
                    setIsAuthOpen(true)
                    setIsMobileMenuOpen(false)
                  }}
                  className="w-full px-4 py-2 text-left text-sm font-medium text-dark-600 dark:text-dark-300 hover:bg-dark-100 dark:hover:bg-dark-800 rounded-lg"
                >
                  {t('nav.login')}
                </button>
                <button
                  onClick={() => {
                    setIsAuthOpen(true)
                    setIsMobileMenuOpen(false)
                  }}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-primary-600 text-white hover:bg-primary-700"
                >
                  <Sparkles className="w-4 h-4" />
                  {t('nav.cta')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Auth Modal */}
      <AuthModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} />
    </nav>
  )
}
