'use client'

import React, { useState, useEffect } from 'react'
import { useLanguage } from '../../LanguageContext'
import Header from '../../components/Header'
import { Terminal, Activity, Zap, PlayCircle, FolderGit2 } from 'lucide-react'
import { motion } from 'framer-motion'

export default function Dashboard() {
  const { t } = useLanguage()
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    const mockLogs = [
      t('dashboard.mockLog1'),
      t('dashboard.mockLog2'),
      t('dashboard.mockLog3'),
      t('dashboard.mockLog4'),
      t('dashboard.mockLog5'),
      t('dashboard.mockLog6'),
    ]

    let currentIndex = 0
    const interval = setInterval(() => {
      if (currentIndex < mockLogs.length) {
        const nextLog = mockLogs[currentIndex]
        setLogs((prev) => [...prev, nextLog])
        currentIndex++
      } else {
        clearInterval(interval)
      }
    }, 1500)

    return () => clearInterval(interval)
  }, [t])

  return (
    <main className="min-h-screen flex flex-col bg-[var(--bg-deep)]">
      <Header />

      <div className="flex-1 container mx-auto px-8 py-8 flex flex-col lg:flex-row gap-8">
        {/* Left Column: Stats & Actions */}
        <div className="lg:w-1/3 flex flex-col gap-6">
          <div className="glass-panel p-6">
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
              <Activity className="text-[#06b6d4]" />
              {t('dashboard.title')}
            </h2>

            <div className="space-y-4">
              <div className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] flex justify-between items-center">
                <span className="text-[var(--text-secondary)]">
                  {t('dashboard.activeMissions')}
                </span>
                <span className="font-bold text-xl text-white">3</span>
              </div>
              <div className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] flex justify-between items-center">
                <span className="text-[var(--text-secondary)]">{t('dashboard.uptime')}</span>
                <span className="font-bold text-xl text-[#10b981]">99.9%</span>
              </div>
              <div className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] flex justify-between items-center">
                <span className="text-[var(--text-secondary)]">{t('dashboard.successRate')}</span>
                <span className="font-bold text-xl text-[#7c3aed]">100%</span>
              </div>
            </div>
          </div>

          <button className="bg-white text-black p-4 rounded-xl font-bold hover:scale-105 transition-transform flex items-center justify-center gap-2">
            <PlayCircle size={20} />
            {t('dashboard.relaunchBtn')}
          </button>
        </div>

        {/* Right Column: Live Terminal */}
        <div className="lg:w-2/3 glass-panel p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4 border-b border-[var(--glass-border)] pb-4">
            <h3 className="font-bold flex items-center gap-2">
              <Terminal className="text-[#f472b6]" size={18} />
              {t('dashboard.cognitiveLogs')}
            </h3>
            <div className="flex items-center gap-2 text-xs font-medium text-[#10b981] bg-[rgba(16,185,129,0.1)] px-3 py-1 rounded-full border border-[rgba(16,185,129,0.2)]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10b981] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10b981]"></span>
              </span>
              {t('dashboard.agentStatus')}
            </div>
          </div>

          <div className="flex-1 bg-[var(--bg-deep)] rounded-xl p-4 font-mono text-sm overflow-y-auto border border-[var(--glass-border)] relative">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <FolderGit2 size={120} />
            </div>
            {logs.map((log, i) => (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                key={i}
                className="mb-3 text-[var(--text-secondary)]"
              >
                <span className="text-[#06b6d4] mr-2">[{new Date().toLocaleTimeString()}]</span>
                <span
                  dangerouslySetInnerHTML={{
                    __html: (log || '')
                      .replace(/\[([^\]]+)\]/g, '<span class="text-[#7c3aed]">[$1]</span>')
                      .replace(/(SUCCESS)/g, '<span class="text-[#10b981] font-bold">$1</span>'),
                  }}
                />
              </motion.div>
            ))}

            <div className="mt-4 flex items-center gap-2 text-[var(--text-secondary)] animate-pulse">
              <span>_</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
