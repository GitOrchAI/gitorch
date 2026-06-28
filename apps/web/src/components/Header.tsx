'use client'

import React, { useEffect, useState } from 'react'
import { useLanguage, Language } from '../LanguageContext'
import { Star, Globe } from 'lucide-react'
import Link from 'next/link'

export default function Header() {
  const { language, setLanguage, t } = useLanguage()
  const [stars, setStars] = useState<number | null>(null)

  useEffect(() => {
    fetch('https://api.github.com/repos/gitorch/gitorch')
      .then((res) => res.json())
      .then((data) => setStars(data.stargazers_count || 420))
      .catch(() => setStars(420))
  }, [])

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLanguage(e.target.value as Language)
  }

  return (
    <header className="w-full py-6 px-8 flex items-center justify-between z-10 relative">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-2xl font-bold tracking-tighter flex items-center gap-3">
          <span>
            Git
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#7c3aed] to-[#06b6d4]">
              Orch
            </span>
          </span>
          <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-[#ffffff10] border border-[#ffffff20] text-gray-300">
            OPEN CORE
          </span>
        </Link>
        <nav className="hidden md:flex gap-6 text-sm font-medium text-[var(--text-secondary)] ml-4">
          <Link href="#anatomy" className="hover:text-white transition-colors">
            {t('nav.anatomy')}
          </Link>
          <Link href="#pricing" className="hover:text-white transition-colors">
            {t('nav.pricing')}
          </Link>
        </nav>
      </div>

      <div className="flex items-center gap-4 sm:gap-6">
        <div className="hidden lg:flex items-center gap-2 glass-panel px-4 py-2 rounded-full text-sm hover:border-[#06b6d4] transition-colors cursor-pointer">
          <Star size={16} className="text-[#06b6d4] fill-[#06b6d4]" />
          <span className="font-bold">{stars !== null ? stars.toLocaleString() : '...'}</span>
          <span className="text-[var(--text-secondary)]">{t('hero.githubStars')}</span>
        </div>

        <div className="flex items-center gap-2 text-sm bg-[var(--bg-surface-elevated)] rounded-full px-3 py-1 border border-[var(--glass-border)]">
          <Globe size={14} className="text-[var(--text-secondary)]" />
          <select
            value={language}
            onChange={handleLanguageChange}
            className="bg-transparent border-none outline-none text-white font-medium cursor-pointer text-xs"
          >
            <option value="en" className="bg-[#0a0a0f]">
              EN
            </option>
            <option value="pt" className="bg-[#0a0a0f]">
              PT
            </option>
            <option value="es" className="bg-[#0a0a0f]">
              ES
            </option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/setup"
            className="hidden sm:block text-sm font-bold text-[var(--text-secondary)] hover:text-white transition-colors"
          >
            {t('nav.login')}
          </Link>
          <Link
            href="/setup"
            className="bg-[#7c3aed] text-white px-5 py-2.5 rounded-full text-sm font-bold hover:glow-text hover:scale-105 transition-all flex items-center gap-2"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-1"
            >
              <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
              <path d="M9 18c-4.51 2-5-2-7-2" />
            </svg>
            {t('nav.startAuto')}
          </Link>
        </div>
      </div>
    </header>
  )
}
