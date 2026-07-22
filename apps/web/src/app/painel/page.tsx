'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useLanguage } from '../../LanguageContext'
import Header from '../../components/Header'
import { Terminal, Activity, FolderGit2, LogIn, HelpCircle } from 'lucide-react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { API_BASE_URL } from '../../lib/api'
import {
  fetchAgentQuestions,
  sortQuestions,
  statusLabel,
  type AgentQuestionView,
} from '../../components/painel/agent-questions'

// Painel READ-ONLY (Fase 4, épico 4.3): mostra o GitHub/missões do cliente
// organizados — NUNCA opera agentes (eles são autônomos) e NUNCA inventa
// número. Sem sessão → convite honesto para conectar. Com sessão → dados
// reais da API, com estado vazio honesto.

interface Mission {
  id: string
  type: string
  status: string
  error?: string | null
  result?: { output?: string } | null
  createdAt: string
  completedAt?: string | null
}

interface MissionsResponse {
  missions: Mission[]
  stats: { active: number; completed: number; failed: number }
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#10b981',
  running: '#06b6d4',
  pending: '#f59e0b',
  failed: '#ef4444',
}

// Cores do badge de status das dúvidas dos agentes (W3.4.2) — mesma paleta
// semântica dos status de missão acima (âmbar=espera, verde=resolvido).
const QUESTION_STATUS_COLORS: Record<string, string> = {
  open: '#f59e0b',
  answered: '#10b981',
  expired: '#6b7280',
}

export default function Dashboard() {
  const { t } = useLanguage()
  // Sessão via cookie httpOnly (não lido por JS) — o painel checa no
  // servidor se está autenticado, nunca lê um token local (spec §17.4).
  // `null` = ainda checando (evita piscar a tela de "conectar" pra quem já
  // está logado); `checkFailed` distingue "não logado" de "não deu pra
  // checar" (rede/CORS/5xx), que senão viravam a mesma tela sem explicação.
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const [data, setData] = useState<MissionsResponse | null>(null)
  const [error, setError] = useState(false)
  // Dúvidas dos agentes (W3.4.2) — READ-ONLY: o painel só EXIBE, responder
  // continua sendo pelo Telegram. Falha na busca não derruba o painel, a
  // seção só fica vazia (fetchAgentQuestions nunca lança).
  const [questions, setQuestions] = useState<AgentQuestionView[]>([])

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE_URL}/api/v1/auth/me`, { credentials: 'include' })
      .then((res) => {
        if (!cancelled) setAuthenticated(res.ok)
      })
      .catch(() => {
        if (!cancelled) {
          setAuthenticated(false)
          setCheckFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async () => {
    if (!authenticated) return
    try {
      const res = await fetch(`${API_BASE_URL}/api/missions`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`${res.status}`)
      setData((await res.json()) as MissionsResponse)
      setError(false)
    } catch {
      setError(true)
    }
  }, [authenticated])

  useEffect(() => {
    if (!authenticated) return
    // Primeiro load fora do corpo síncrono do effect (regra react-hooks).
    queueMicrotask(() => void load())
    // Ao vivo de verdade: atualiza a cada 15s enquanto a aba está aberta.
    const interval = setInterval(() => void load(), 15_000)
    return () => clearInterval(interval)
  }, [authenticated, load])

  useEffect(() => {
    if (!authenticated) return
    let cancelled = false
    fetchAgentQuestions(API_BASE_URL)
      .then((qs) => {
        if (!cancelled) setQuestions(qs)
      })
      .catch(() => {
        // fetchAgentQuestions já nunca lança, mas por contrato: falha aqui
        // nunca derruba o painel, só mantém a seção vazia.
      })
    return () => {
      cancelled = true
    }
  }, [authenticated])

  // Ainda checando a sessão: nem afirma nem nega login, só não mostra nada
  // definitivo ainda — evita o flash de "conecte-se" pra quem já está logado.
  if (authenticated === null) {
    return (
      <main className="min-h-screen flex flex-col bg-[var(--bg-deep)]">
        <Header />
        <div className="flex-1 flex items-center justify-center px-8">
          <p className="text-[var(--text-secondary)]">{t('dashboard.checkingSession')}</p>
        </div>
      </main>
    )
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen flex flex-col bg-[var(--bg-deep)]">
        <Header />
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="glass-panel p-10 text-center max-w-md">
            <div className="w-16 h-16 mx-auto bg-[rgba(124,58,237,0.1)] text-[#7c3aed] rounded-full flex items-center justify-center mb-6">
              <LogIn size={28} />
            </div>
            <h2 className="text-2xl font-bold mb-3">{t('dashboard.connectTitle')}</h2>
            <p className="text-[var(--text-secondary)] mb-8">
              {checkFailed ? t('dashboard.connectCheckError') : t('dashboard.connectDesc')}
            </p>
            <Link
              href="/setup"
              className="inline-block bg-white text-black px-8 py-3 rounded-full font-bold hover:scale-105 transition-transform"
            >
              {t('dashboard.connectBtn')}
            </Link>
          </div>
        </div>
      </main>
    )
  }

  const stats = data?.stats
  const missions = data?.missions ?? []

  return (
    <main className="min-h-screen flex flex-col bg-[var(--bg-deep)]">
      <Header />

      <div className="flex-1 container mx-auto px-8 py-8 flex flex-col lg:flex-row gap-8">
        {/* Coluna esquerda: números REAIS */}
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
                <span className="font-bold text-xl text-white">{stats ? stats.active : '—'}</span>
              </div>
              <div className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] flex justify-between items-center">
                <span className="text-[var(--text-secondary)]">
                  {t('dashboard.statsCompleted')}
                </span>
                <span className="font-bold text-xl text-[#10b981]">
                  {stats ? stats.completed : '—'}
                </span>
              </div>
              <div className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] flex justify-between items-center">
                <span className="text-[var(--text-secondary)]">{t('dashboard.statsFailed')}</span>
                <span className="font-bold text-xl text-[#ef4444]">
                  {stats ? stats.failed : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Coluna direita: missões recentes reais */}
        <div className="lg:w-2/3 glass-panel p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4 border-b border-[var(--glass-border)] pb-4">
            <h3 className="font-bold flex items-center gap-2">
              <Terminal className="text-[#f472b6]" size={18} />
              {t('dashboard.recentMissions')}
            </h3>
          </div>

          <div className="flex-1 bg-[var(--bg-deep)] rounded-xl p-4 font-mono text-sm overflow-y-auto border border-[var(--glass-border)] relative">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <FolderGit2 size={120} />
            </div>

            {error && <div className="text-[#ef4444]">{t('dashboard.loadError')}</div>}

            {!error && missions.length === 0 && (
              <div className="text-[var(--text-secondary)]">{t('dashboard.noMissions')}</div>
            )}

            {missions.map((m) => (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                key={m.id}
                className="mb-3 text-[var(--text-secondary)]"
              >
                <span className="text-[#06b6d4] mr-2">
                  [{new Date(m.createdAt).toLocaleString()}]
                </span>
                <span
                  className="mr-2 font-bold"
                  style={{ color: STATUS_COLORS[m.status] ?? '#9ca3af' }}
                >
                  {m.status.toUpperCase()}
                </span>
                <span className="text-white mr-2">{m.type}</span>
                {m.result?.output && (
                  <span className="block pl-4 text-xs opacity-80 whitespace-pre-wrap">
                    {m.result.output.split('\n')[0]?.slice(0, 160)}
                  </span>
                )}
                {m.error && (
                  <span className="block pl-4 text-xs text-[#ef4444] opacity-90">
                    {m.error.slice(0, 160)}
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Dúvidas dos agentes (W3.4.2) — READ-ONLY: só exibe. Responder é pelo
          Telegram (o clique-a-clique fica pra próxima fase). */}
      <div className="container mx-auto px-8 pb-8">
        <div className="glass-panel p-6">
          <div className="flex items-center justify-between mb-4 border-b border-[var(--glass-border)] pb-4">
            <h3 className="font-bold flex items-center gap-2">
              <HelpCircle className="text-[#f59e0b]" size={18} />
              Dúvidas dos agentes
            </h3>
          </div>

          {questions.length === 0 && (
            <div className="text-[var(--text-secondary)]">Nenhuma dúvida no momento.</div>
          )}

          <div className="space-y-4">
            {sortQuestions(questions).map((q) => (
              <div
                key={q.id}
                className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)]"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <span className="text-white font-medium">{q.text}</span>
                  <span
                    className="text-xs font-bold px-2 py-1 rounded-full whitespace-nowrap"
                    style={{
                      color: QUESTION_STATUS_COLORS[q.status] ?? '#9ca3af',
                      backgroundColor: 'rgba(255,255,255,0.05)',
                    }}
                  >
                    {statusLabel(q.status)}
                  </span>
                </div>

                {q.context && (
                  <p className="text-sm text-[var(--text-secondary)] mb-2">{q.context}</p>
                )}

                {q.options.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {q.options.map((opt) => (
                      <span
                        key={opt.value}
                        className="text-xs px-3 py-1 rounded-full border border-[var(--glass-border)] text-[var(--text-secondary)]"
                      >
                        {opt.label}
                      </span>
                    ))}
                  </div>
                )}

                {q.status === 'answered' && q.answer && (
                  <p className="text-sm text-[#10b981]">Resposta: {q.answer}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
