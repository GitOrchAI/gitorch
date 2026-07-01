import React from 'react'
import { ChevronRight, ShieldAlert, BadgeCheck } from 'lucide-react'

interface StepPlanSelectionProps {
  plan: string
  setPlan: (plan: string) => void
  onNext: () => void
  onBack: () => void
}

export default function StepPlanSelection({
  plan,
  setPlan,
  onNext,
  onBack,
}: StepPlanSelectionProps) {
  return (
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Escolha seu Plano</h2>
      <p className="text-[var(--text-secondary)] mb-8">
        Adote o GitOrch de forma totalmente gratuita ou inicie um teste gratuito de 30 dias na
        nuvem.
      </p>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Free Plan */}
        <div
          onClick={() => setPlan('free')}
          className={`flex flex-col p-6 rounded-2xl border cursor-pointer transition-all ${
            plan === 'free'
              ? 'bg-[rgba(124,58,237,0.05)] border-[#7c3aed]'
              : 'bg-[var(--bg-surface-elevated)] border-[var(--glass-border)] hover:border-[#ffffff20]'
          }`}
        >
          <div className="flex justify-between items-center mb-3">
            <span className="font-bold text-white text-lg flex items-center gap-1.5">
              <ShieldAlert size={18} className="text-[#06b6d4]" /> Grátis
            </span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--glass-border)]">
              1 repositório
            </span>
          </div>
          <div className="text-3xl font-black mb-4 font-mono">$0</div>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-4">
            Ideal para desenvolvedores solo ou testes rápidos em um único projeto pessoal.
          </p>
          <ul className="text-[10px] text-[var(--text-secondary)] space-y-1.5 mt-auto">
            <li className="flex items-center gap-1">✓ 1 Repositório Ativo</li>
            <li className="flex items-center gap-1">✓ Motores locais (Self-Hosted)</li>
            <li className="flex items-center gap-1">✓ Limitações de processamento RAG</li>
          </ul>
        </div>

        {/* Cloud Pro Plan */}
        <div
          onClick={() => setPlan('pro')}
          className={`flex flex-col p-6 rounded-2xl border cursor-pointer transition-all relative overflow-hidden ${
            plan === 'pro'
              ? 'bg-[rgba(124,58,237,0.05)] border-[#7c3aed]'
              : 'bg-[var(--bg-surface-elevated)] border-[var(--glass-border)] hover:border-[#ffffff20]'
          }`}
        >
          <div className="absolute top-0 right-0 bg-[#7c3aed] text-white text-[8px] font-bold px-3 py-1 rounded-bl-xl tracking-wider uppercase">
            Popular
          </div>
          <div className="flex justify-between items-center mb-3">
            <span className="font-bold text-[#7c3aed] text-lg flex items-center gap-1.5">
              <BadgeCheck size={18} /> Cloud Pro
            </span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[rgba(124,58,237,0.1)] text-[#7c3aed] border border-[rgba(124,58,237,0.2)]">
              Até 2 repos
            </span>
          </div>
          <div className="text-3xl font-black mb-4 font-mono">
            $19<span className="text-xs font-normal text-[var(--text-secondary)]">/mês</span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-4">
            30 dias grátis. Acesso total na nuvem para times em crescimento. Redireciona via Stripe.
          </p>
          <ul className="text-[10px] text-[var(--text-secondary)] space-y-1.5 mt-auto">
            <li className="flex items-center gap-1">✓ Até 2 Repositórios Ativos</li>
            <li className="flex items-center gap-1">✓ Execução autônoma na nossa Cloud</li>
            <li className="flex items-center gap-1">✓ Sem rate limit de tokens</li>
            <li className="flex items-center gap-1">✓ Integrações extras de telemetria</li>
          </ul>
        </div>
      </div>

      <div className="mt-auto flex justify-between pt-6">
        <button
          onClick={onBack}
          className="text-[var(--text-secondary)] hover:text-white transition-colors px-4 py-2"
        >
          Voltar
        </button>
        <button
          onClick={onNext}
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 hover:scale-105 transition-transform cursor-pointer"
        >
          Avançar <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
