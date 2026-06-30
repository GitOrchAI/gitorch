'use client'

import React from 'react'
import { useLanguage } from '../LanguageContext'
import Header from '../components/Header'
import Canvas3D from '../components/Canvas3D'
import { motion } from 'framer-motion'
import { ShieldCheck, Zap, Server, Code2, GitBranch } from 'lucide-react'
import Link from 'next/link'

export default function Home() {
  const { t } = useLanguage()

  return (
    <main className="relative min-h-screen flex flex-col overflow-hidden bg-[var(--bg-deep)]">
      {/* 3D Background/Sidebar (Canvas) */}
      <div className="absolute right-0 top-0 w-full lg:w-[55%] h-[100vh] z-0 opacity-30 lg:opacity-100 pointer-events-none">
        <Canvas3D />
      </div>

      <Header />

      {/* Hero Section */}
      <section className="flex-1 flex flex-col justify-center px-8 z-10 container mx-auto min-h-[85vh]">
        <div className="max-w-2xl mt-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 border border-[var(--accent-neon-violet)] bg-[rgba(124,58,237,0.1)] text-[#7c3aed] px-4 py-1.5 rounded-full text-xs font-bold tracking-widest mb-8"
          >
            <Zap size={14} className="fill-[#7c3aed]" />
            {t('hero.badge')}
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-5xl md:text-6xl lg:text-7xl font-bold leading-[1.05] tracking-tight mb-6"
          >
            {t('hero.title')}
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-lg md:text-xl text-[var(--text-secondary)] leading-relaxed mb-10 max-w-xl font-medium"
          >
            {t('hero.subtitle')}
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                href="/setup"
                className="bg-white text-black px-8 py-4 rounded-full font-bold hover:scale-105 transition-transform flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(255,255,255,0.2)]"
              >
                <svg
                  width="20"
                  height="20"
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
                {t('hero.ctaPrimary')}
              </Link>
            </div>
            <p className="text-xs text-[var(--text-secondary)] flex items-center gap-2 ml-2 mt-1">
              <ShieldCheck size={14} className="text-[#10b981]" />
              {t('hero.ctaMicro')}
            </p>
          </motion.div>
        </div>
      </section>

      {/* Anatomy of the Solution (Business Value) */}
      <section id="anatomy" className="container mx-auto px-8 py-32 z-10 relative">
        <div className="text-center max-w-3xl mx-auto mb-20">
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            {t('anatomy.title')}
          </h2>
          <p className="text-xl text-[var(--text-secondary)]">{t('anatomy.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 perspective-container">
          <AnatomyCard
            icon={<GitBranch size={32} className="text-[#06b6d4]" />}
            title={t('anatomy.syncTitle')}
            desc={t('anatomy.syncDesc')}
            color="#06b6d4"
          />
          <AnatomyCard
            icon={<Code2 size={32} className="text-[#f472b6]" />}
            title={t('anatomy.ragTitle')}
            desc={t('anatomy.ragDesc')}
            color="#f472b6"
          />
          <AnatomyCard
            icon={<Server size={32} className="text-[#7c3aed]" />}
            title={t('anatomy.cortexTitle')}
            desc={t('anatomy.cortexDesc')}
            color="#7c3aed"
          />
        </div>
      </section>

      {/* Pricing Section */}
      <section
        id="pricing"
        className="container mx-auto px-8 py-32 z-10 relative border-t border-[var(--glass-border)]"
      >
        <div className="text-center max-w-3xl mx-auto mb-20">
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            {t('pricing.title')}
          </h2>
          <p className="text-xl text-[var(--text-secondary)]">{t('pricing.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {/* Open Core */}
          <div className="glass-panel p-8 rounded-3xl flex flex-col border border-[var(--glass-border)] opacity-80 hover:opacity-100 transition-opacity">
            <h3 className="text-2xl font-bold mb-2">{t('pricing.openCore')}</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-6 h-10">
              {t('pricing.openCoreTarget')}
            </p>
            <div className="text-5xl font-black mb-8 font-mono">{t('pricing.openCorePrice')}</div>
            <p className="text-[var(--text-secondary)] mb-10 flex-1">{t('pricing.openCoreDesc')}</p>
            <a
              href="https://github.com/gitorch/gitorch"
              target="_blank"
              rel="noreferrer"
              className="w-full py-4 rounded-full border border-[var(--glass-border)] font-bold hover:bg-[var(--bg-surface-elevated)] transition-colors text-center"
            >
              {t('pricing.btnFree')}
            </a>
          </div>

          {/* Cloud Pro (Highlight) */}
          <div className="glass-panel p-8 rounded-3xl flex flex-col border border-[#7c3aed] relative shadow-[0_0_50px_rgba(124,58,237,0.15)] transform md:-translate-y-4">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#7c3aed] text-white px-4 py-1 rounded-full text-xs font-bold tracking-wider">
              RECOMENDADO
            </div>
            <h3 className="text-2xl font-bold mb-2 text-[#7c3aed]">{t('pricing.cloudPro')}</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-6 h-10">
              {t('pricing.cloudProTarget')}
            </p>
            <div className="text-4xl font-black mb-8">{t('pricing.cloudProPrice')}</div>
            <p className="text-[var(--text-secondary)] mb-10 flex-1">{t('pricing.cloudProDesc')}</p>
            <Link
              href="/setup"
              className="w-full py-4 rounded-full bg-[#7c3aed] text-white font-bold hover:glow-border hover:scale-105 transition-all text-center"
            >
              {t('pricing.btnPro')}
            </Link>
          </div>

          {/* Enterprise */}
          <div className="glass-panel p-8 rounded-3xl flex flex-col border border-[var(--glass-border)] opacity-80 hover:opacity-100 transition-opacity">
            <h3 className="text-2xl font-bold mb-2">{t('pricing.enterprise')}</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-6 h-10">
              {t('pricing.enterpriseTarget')}
            </p>
            <div className="text-4xl font-black mb-8">{t('pricing.enterprisePrice')}</div>
            <p className="text-[var(--text-secondary)] mb-10 flex-1">
              {t('pricing.enterpriseDesc')}
            </p>
            <Link
              href="/setup"
              className="w-full py-4 rounded-full bg-white text-black font-bold hover:scale-105 transition-transform text-center"
            >
              {t('pricing.btnEnterprise')}
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}

function AnatomyCard({
  icon,
  title,
  desc,
  color,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  color: string
}) {
  return (
    <div className="glass-panel p-8 tilt-card flex flex-col min-h-[320px] relative overflow-hidden group border border-[var(--glass-border)] hover:border-[#ffffff40] transition-colors">
      <div
        className="absolute -top-10 -right-10 w-40 h-40 rounded-full blur-[80px] opacity-10 transition-opacity group-hover:opacity-40"
        style={{ backgroundColor: color }}
      />
      <div className="mb-8 w-16 h-16 rounded-2xl bg-[var(--bg-surface-elevated)] flex items-center justify-center border border-[var(--glass-border)] group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <div>
        <h3 className="text-2xl font-bold mb-4 tracking-tight">{title}</h3>
        <p className="text-[var(--text-secondary)] font-medium leading-relaxed">{desc}</p>
      </div>
      <div
        className="absolute bottom-0 left-0 w-full h-[3px] opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
      />
    </div>
  )
}
