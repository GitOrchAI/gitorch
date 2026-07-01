import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Github, Mail, Chrome, X, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState<string | null>(null)

  const authProviders = [
    {
      id: 'github',
      label: t('auth.modal.github'),
      icon: Github,
      color: 'hover:bg-gray-100 dark:hover:bg-dark-700',
      action: () => handleAuth('github'),
    },
    {
      id: 'google',
      label: t('auth.modal.google'),
      icon: Chrome,
      color: 'hover:bg-gray-100 dark:hover:bg-dark-700',
      action: () => handleAuth('google'),
    },
    {
      id: 'email',
      label: t('auth.modal.email'),
      icon: Mail,
      color: 'hover:bg-gray-100 dark:hover:bg-dark-700',
      action: () => handleAuth('email'),
    },
  ]

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = 'unset'
    }
  }, [isOpen, onClose])

  const handleAuth = (provider: string) => {
    setLoading(provider)
    if (provider === 'github') {
      const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID
      const redirectUri = `${window.location.origin}/auth/callback`
      const scope = 'repo read:org user:email'
      const state = Math.random().toString(36).substring(7)
      sessionStorage.setItem('oauth_state', state)
      window.location.href = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`
    } else if (provider === 'google') {
      // Google OAuth implementation
      console.log('Google OAuth - to be implemented')
    } else if (provider === 'email') {
      // Email magic link implementation
      console.log('Email magic link - to be implemented')
    }
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className={cn(
            'w-full max-w-md',
            'bg-white dark:bg-dark-900',
            'rounded-2xl shadow-2xl',
            'overflow-hidden'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-dark-200 dark:border-dark-700">
            <h2
              id="auth-modal-title"
              className="text-xl font-semibold text-dark-900 dark:text-white"
            >
              {t('auth.modal.title')}
            </h2>
            <button
              onClick={onClose}
              className={cn(
                'p-2 rounded-lg',
                'text-dark-400 hover:text-dark-600 dark:hover:text-dark-200',
                'hover:bg-dark-100 dark:hover:bg-dark-800',
                'transition-colors'
              )}
              aria-label={t('auth.modal.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-6 space-y-4">
            <p className="text-center text-dark-600 dark:text-dark-400 text-sm">
              {t('auth.modal.subtitle')}
            </p>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-dark-200 dark:border-dark-700" />
              </div>
              <span className="relative flex justify-center text-sm font-medium text-dark-500 dark:text-dark-500 px-4 bg-white dark:bg-dark-900">
                {t('auth.modal.divider')}
              </span>
            </div>

            <div className="grid gap-3">
              {authProviders.map((provider) => (
                <motion.button
                  key={provider.id}
                  disabled={!!loading}
                  onClick={provider.action}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className={cn(
                    'w-full flex items-center justify-center gap-3 px-4 py-3',
                    'rounded-xl border border-dark-200 dark:border-dark-700',
                    'text-sm font-medium text-dark-700 dark:text-dark-300',
                    'transition-all duration-200',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    provider.color
                  )}
                >
                  <provider.icon className="w-5 h-5" />
                  {loading === provider.id ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>{provider.label}...</span>
                    </>
                  ) : (
                    provider.label
                  )}
                </motion.button>
              ))}
            </div>

            <p className="text-center text-xs text-dark-500 dark:text-dark-500">
              {t('auth.modal.description')}
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
