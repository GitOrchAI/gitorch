import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ArrowRight, Sparkles } from 'lucide-react'
import { HeroScene } from '@/components/three/HeroScene'
import { motion } from 'framer-motion'

interface Hero3DProps {
  className?: string
}

export function Hero3D({ className }: Hero3DProps) {
  const { t } = useTranslation()

  return (
    <section
      id="hero"
      className={cn(
        'relative min-h-screen flex items-center justify-center',
        'overflow-hidden',
        className
      )}
      aria-labelledby="hero-title"
    >
      {/* 3D Background */}
      <div className="absolute inset-0 z-0">
        <HeroScene />
      </div>

      {/* Gradient Overlay */}
      <div className="absolute inset-0 z-10 bg-gradient-to-b from-dark-950/80 via-dark-900/60 to-dark-950/80 dark:from-dark-950 dark:via-dark-900/50 dark:to-dark-950" />

      {/* Content */}
      <div className="relative z-20 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 lg:py-32">
        <div className="text-center max-w-4xl mx-auto">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-600/20 border border-primary-500/30 text-primary-400 text-sm font-medium mb-8"
          >
            <Sparkles className="w-4 h-4 animate-pulse" />
            <span>New: Mission Control Dashboard (F9)</span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            id="hero-title"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tight text-white mb-6 text-balance"
          >
            {t('hero.headline')}
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="text-lg sm:text-xl text-dark-300 dark:text-dark-400 max-w-3xl mx-auto mb-10 leading-relaxed text-balance"
          >
            {t('hero.subheadline')}
          </motion.p>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <button
              className={cn(
                'group flex items-center justify-center gap-3 px-8 py-4',
                'text-base font-semibold rounded-xl',
                'bg-primary-600 text-white',
                'hover:bg-primary-700',
                'shadow-xl shadow-primary-600/30',
                'transition-all duration-300',
                'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-dark-950'
              )}
            >
              {t('hero.cta')}
              <ArrowRight
                className={cn('w-5 h-5 transition-transform', 'group-hover:translate-x-1')}
              />
            </button>
            <button
              className={cn(
                'flex items-center justify-center gap-2 px-8 py-4',
                'text-base font-semibold rounded-xl',
                'bg-white/10 dark:bg-dark-800/50',
                'border border-white/20 dark:border-dark-700',
                'text-white hover:bg-white/20',
                'transition-all duration-300',
                'backdrop-blur-sm'
              )}
            >
              <span className="text-sm opacity-70">GitHub</span>
              <span>Stars</span>
            </button>
          </motion.div>

          {/* Microcopy */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.6 }}
            className="mt-6 text-sm text-dark-400 dark:text-dark-500"
          >
            {t('hero.microcopy')}
          </motion.p>

          {/* Trust Indicators */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7 }}
            className="mt-16 flex flex-wrap items-center justify-center gap-8 text-sm text-dark-500 dark:text-dark-500"
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 14.586 7.707 13.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
              <span>Open Core (MIT)</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-primary-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
              </svg>
              <span>Zero vendor lock-in</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              <span>Self-hosted option</span>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Scroll Indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2, duration: 0.8 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20"
      >
        <div className="flex flex-col items-center gap-2 text-dark-400 dark:text-dark-500">
          <span className="text-xs uppercase tracking-wider">Scroll</span>
          <motion.div
            animate={{ y: [0, 10, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            className="w-6 h-10 border-2 border-dark-400 dark:border-dark-500 rounded-full flex justify-center pt-2"
          >
            <motion.div
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              className="w-1.5 h-1.5 bg-dark-400 dark:bg-dark-500 rounded-full"
            />
          </motion.div>
        </div>
      </motion.div>
    </section>
  )
}
