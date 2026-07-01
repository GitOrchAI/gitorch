import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Github, Discord, Twitter, ExternalLink, Mail } from 'lucide-react'
import { getCurrentYear } from '@/lib/utils'

interface FooterProps {
  className?: string
}

export function Footer({ className }: FooterProps) {
  const { t } = useTranslation()
  const year = getCurrentYear()

  const links = {
    product: [
      {
        label: t('footer.github'),
        href: 'https://github.com/loureng/gitorch',
        icon: Github,
        external: true,
      },
      { label: t('footer.docs'), href: '/docs' },
      { label: t('footer.blog'), href: '/blog' },
      { label: t('footer.changelog'), href: '/changelog' },
    ],
    company: [
      { label: t('footer.about'), href: '/about' },
      { label: t('footer.careers'), href: '/careers' },
      { label: t('footer.contact'), href: '/contact' },
    ],
    resources: [
      {
        label: t('footer.discord'),
        href: 'https://discord.gg/gitorch',
        icon: Discord,
        external: true,
      },
      {
        label: t('footer.twitter'),
        href: 'https://twitter.com/gitorch',
        icon: Twitter,
        external: true,
      },
    ],
    legal: [
      { label: t('footer.privacy'), href: '/privacy' },
      { label: t('footer.terms'), href: '/terms' },
      { label: t('footer.cookie'), href: '/cookies' },
    ],
  }

  const socialLinks = [
    { icon: Github, href: 'https://github.com/loureng/gitorch', label: 'GitHub' },
    { icon: Discord, href: 'https://discord.gg/gitorch', label: 'Discord' },
    { icon: Twitter, href: 'https://twitter.com/gitorch', label: 'Twitter' },
    { icon: Mail, href: 'mailto:hello@gitorch.io', label: 'Email' },
  ]

  return (
    <footer
      className={cn(
        'bg-white dark:bg-dark-950 border-t border-dark-200 dark:border-dark-800',
        className
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-8 lg:gap-12">
          {/* Brand */}
          <div className="col-span-2 lg:col-span-1">
            <div className="flex items-center gap-3 mb-4">
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
              <span className="text-xl font-bold text-dark-900 dark:text-white">GitOrch</span>
            </div>
            <p className="text-dark-600 dark:text-dark-400 text-sm mb-6 max-w-xs">
              Orquestre agentes de IA diretamente no fluxo do seu GitHub. Automação de engenharia
              sem fricção.
            </p>
            <div className="flex gap-4">
              {socialLinks.map(({ icon: Icon, href, label }) => (
                <a
                  key={label}
                  href={href}
                  target={href.startsWith('http') ? '_blank' : undefined}
                  rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
                  className={cn(
                    'p-2 rounded-lg',
                    'text-dark-400 hover:text-primary-600 dark:hover:text-primary-400',
                    'hover:bg-dark-100 dark:hover:bg-dark-800',
                    'transition-colors'
                  )}
                  aria-label={label}
                >
                  <Icon className="w-5 h-5" />
                </a>
              ))}
            </div>
          </div>

          {/* Product */}
          <nav aria-label={t('footer.product')}>
            <h3 className="font-semibold text-dark-900 dark:text-white mb-4">
              {t('footer.product')}
            </h3>
            <ul className="space-y-3">
              {links.product.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    target={item.external ? '_blank' : undefined}
                    rel={item.external ? 'noopener noreferrer' : undefined}
                    className={cn(
                      'text-sm text-dark-600 dark:text-dark-400',
                      'hover:text-primary-600 dark:hover:text-primary-400',
                      'transition-colors flex items-center gap-2'
                    )}
                  >
                    {item.label}
                    {item.external && <ExternalLink className="w-3 h-3" />}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Company */}
          <nav aria-label={t('footer.company')}>
            <h3 className="font-semibold text-dark-900 dark:text-white mb-4">
              {t('footer.company')}
            </h3>
            <ul className="space-y-3">
              {links.company.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    className={cn(
                      'text-sm text-dark-600 dark:text-dark-400',
                      'hover:text-primary-600 dark:hover:text-primary-400',
                      'transition-colors'
                    )}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Resources */}
          <nav aria-label={t('footer.resources')}>
            <h3 className="font-semibold text-dark-900 dark:text-white mb-4">
              {t('footer.resources')}
            </h3>
            <ul className="space-y-3">
              {links.resources.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    target={item.external ? '_blank' : undefined}
                    rel={item.external ? 'noopener noreferrer' : undefined}
                    className={cn(
                      'flex items-center gap-2 text-sm text-dark-600 dark:text-dark-400',
                      'hover:text-primary-600 dark:hover:text-primary-400',
                      'transition-colors'
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                    {item.external && <ExternalLink className="w-3 h-3" />}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Legal */}
          <nav aria-label={t('footer.legal')}>
            <h3 className="font-semibold text-dark-900 dark:text-white mb-4">
              {t('footer.legal')}
            </h3>
            <ul className="space-y-3">
              {links.legal.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    className={cn(
                      'text-sm text-dark-600 dark:text-dark-400',
                      'hover:text-primary-600 dark:hover:text-primary-400',
                      'transition-colors'
                    )}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-dark-200 dark:border-dark-800">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-sm text-dark-500 dark:text-dark-500">
              {t('footer.copyright', { year })}
            </p>
            <div className="flex items-center gap-6">
              <a
                href="https://github.com/loureng/gitorch"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-dark-500 dark:text-dark-500 hover:text-primary-600 dark:hover:text-primary-400"
              >
                <Github className="w-4 h-4" />
                <span>Star us on GitHub</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
