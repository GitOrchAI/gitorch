import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'

interface StepTermsProps {
  onAccept: () => void
}

export default function StepTerms({ onAccept }: StepTermsProps) {
  const [accepted, setAccepted] = useState(false)

  return (
    <div className="flex flex-col h-full py-2">
      <h2 className="text-3xl font-bold mb-4">Termos de Serviço e Políticas</h2>
      <p className="text-[var(--text-secondary)] mb-6">
        Por favor, revise e aceite os termos para continuarmos o isolamento e configuração do seu
        workspace.
      </p>

      <div className="flex-1 bg-[var(--bg-surface-elevated)] p-6 rounded-xl border border-[var(--glass-border)] overflow-y-auto max-h-48 text-sm text-[var(--text-secondary)] mb-6 leading-relaxed">
        <h4 className="font-bold text-white mb-2">1. Coleta de Dados e Acesso ao GitHub</h4>
        <p className="mb-4">
          O GitOrch lerá informações dos repositórios selecionados por você para prover
          contextualização semântica (RAG) aos agentes inteligentes. Nós não modificamos seu código
          sem sua autorização explícita ou trigger via pull request.
        </p>
        <h4 className="font-bold text-white mb-2">2. Motores CLI e Credenciais</h4>
        <p className="mb-4">
          Nós oferecemos suporte para Claude Code e Antigravity CLI. Seus tokens serão mantidos de
          forma segura no cofre do Control Plane para autenticação assistida e execução de tarefas
          de codificação.
        </p>
        <h4 className="font-bold text-white mb-2">3. Privacidade e Armazenamento</h4>
        <p>
          Os dados extraídos dos commits e arquivos são armazenados de forma isolada por tenant
          (wingId). Nós não utilizamos seus dados proprietários para treinar modelos globais de
          linguagem.
        </p>
      </div>

      <div
        className="flex items-center gap-3 mb-8 cursor-pointer select-none"
        onClick={() => setAccepted(!accepted)}
      >
        <input
          type="checkbox"
          checked={accepted}
          onChange={() => {}} // Controlled by the parent div click
          className="w-5 h-5 rounded border-[var(--glass-border)] text-[#7c3aed] focus:ring-[#7c3aed] bg-transparent"
        />
        <span className="text-sm text-white">
          Eu li e aceito os termos de serviço e privacidade do GitOrch.
        </span>
      </div>

      <div className="mt-auto flex justify-end">
        <button
          onClick={onAccept}
          disabled={!accepted}
          className="bg-white text-black px-6 py-3 rounded-full font-bold flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform cursor-pointer"
        >
          Aceitar e Continuar <ChevronRight size={18} />
        </button>
      </div>
    </div>
  )
}
