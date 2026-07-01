import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'
import { Github, Brain, Zap, Cpu, ChevronRight } from 'lucide-react'

interface SolutionAnatomyProps {
  className?: string
}

const icons = {
  github: Github,
  brain: Brain,
  zap: Zap,
  cpu: Cpu,
} as const

export function SolutionAnatomy({ className }: SolutionAnatomyProps) {
  const { t } = useTranslation()

  const items = t('solution.items', { returnObjects: true }) as Array<{
    tech: string
    title: string
    benefit: string
  }>

  const iconMap: Record<string, keyof typeof icons> = {
    'GitHub Sync': 'github',
    CodeSight: 'brain',
    Synapse: 'zap',
    'Control Plane': 'cpu',
  }

  return (
    <section
      id="features"
      className={cn('py-20 lg:py-32 px-4 sm:px-6 lg:px-8', 'bg-white dark:bg-dark-950', className)}
      aria-labelledby="solution-title"
    >
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-3xl mx-auto mb-16 lg:mb-20"
        >
          <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-sm font-medium mb-4">
            <span className="w-2 h-2 rounded-full bg-primary-500 animate-pulse" />
            {t('solution.title')}
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-dark-900 dark:text-white mb-4">
            {t('solution.title')}
          </h2>
          <p className="text-lg text-dark-600 dark:text-dark-400 max-w-2xl mx-auto">
            {t('solution.subtitle')}
          </p>
        </motion.div>

        {/* Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
          {items.map((item, index) => {
            const iconKey = iconMap[item.tech.split(' ')[0]] || 'cpu'
            const Icon = icons[iconKey]

            return (
              <motion.article
                key={item.tech}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-100px' }}
                transition={{ duration: 0.6, delay: index * 0.1 }}
                className={cn(
                  'group relative p-6 lg:p-8',
                  'bg-white dark:bg-dark-900',
                  'rounded-2xl',
                  'border border-dark-200 dark:border-dark-800',
                  'hover:border-primary-500/50',
                  'hover:shadow-xl hover:shadow-primary-500/10',
                  'transition-all duration-500'
                )}
              >
                {/* Tech Badge */}
                <motion.span
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.2 }}
                  className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-xs font-medium mb-4"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />
                  {item.tech}
                </motion.span>

                {/* Icon */}
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.3 }}
                  className="w-14 h-14 rounded-xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300"
                >
                  <Icon className="w-7 h-7 text-primary-600 dark:text-primary-400" />
                </motion.div>

                {/* Title */}
                <motion.h3
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.4 }}
                  className="text-xl font-semibold text-dark-900 dark:text-white mb-3"
                >
                  {item.title}
                </motion.h3>

                {/* Benefit */}
                <motion.p
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.5 }}
                  className="text-dark-600 dark:text-dark-400 leading-relaxed mb-6"
                >
                  {item.benefit}
                </motion.p>

                {/* Arrow */}
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.6 }}
                  className={cn(
                    'flex items-center gap-2 text-sm font-medium text-primary-600 dark:text-primary-400',
                    'group-hover:gap-3 transition-all duration-300'
                  )}
                >
                  <span>Learn more</span>
                  <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </motion.div>

                {/* Glow effect on hover */}
                <div
                  className={cn(
                    'absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100',
                    'transition-opacity duration-500 pointer-events-none',
                    'bg-gradient-to-br from-primary-500/10 to-transparent'
                  )}
                />
              </motion.article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
