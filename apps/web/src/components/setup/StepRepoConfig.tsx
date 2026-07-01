import React from 'react'
import { ChevronRight, ShieldCheck, Terminal, Copy, Check } from 'lucide-react'
import Link from 'next/link'

interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

interface StepRepoConfigProps {
  projects: CreatedProject[]
}

export default function StepRepoConfig({ projects }: StepRepoConfigProps) {
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null)

  const handleCopy = (key: string, index: number) => {
    navigator.clipboard.writeText(key)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  return (
    <div className="flex flex-col h-full py-2">
      <div className="flex flex-col items-center text-center mb-6">
        <div className="w-16 h-16 bg-[rgba(16,185,129,0.1)] text-[#10b981] rounded-full flex items-center justify-center mb-4 glow-border">
          <ShieldCheck size={32} />
        </div>
        <h2 className="text-3xl font-bold">Workspace Configurado!</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-2 max-w-md">
          Seus repositórios foram clonados com sucesso e as credenciais foram registradas no cofre
          do Control Plane.
        </p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto max-h-[220px] pr-1">
        <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-2">
          Chaves de Integração (API Keys)
        </h4>

        {projects.map((proj, idx) => (
          <div
            key={proj.id}
            className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] space-y-2"
          >
            <div className="flex justify-between items-center text-xs">
              <span className="font-bold text-white">{proj.wingId}</span>
              <span className="text-[10px] text-[var(--text-secondary)] font-mono">
                ID: {proj.id.substring(0, 8)}
              </span>
            </div>

            <div className="flex items-center gap-2 bg-[var(--bg-deep)] px-3 py-2 rounded-lg border border-[var(--glass-border)] justify-between">
              <span className="font-mono text-xs text-[#7c3aed] select-all truncate">
                {proj.apiKey}
              </span>
              <button
                onClick={() => handleCopy(proj.apiKey, idx)}
                className="text-[var(--text-secondary)] hover:text-white transition-colors p-1"
              >
                {copiedIndex === idx ? (
                  <Check size={14} className="text-[#10b981]" />
                ) : (
                  <Copy size={14} />
                )}
              </button>
            </div>
          </div>
        ))}

        <div className="bg-[var(--bg-surface-elevated)] p-4 rounded-xl border border-[var(--glass-border)] text-xs text-[var(--text-secondary)] space-y-2">
          <h5 className="font-bold text-white flex items-center gap-1.5">
            <Terminal size={14} /> Configurando CI/CD e Runners
          </h5>
          <p className="leading-relaxed">
            Como não fornecemos infraestrutura proprietária para compilação, configure o segredo de
            repositório em suas GitHub Actions:
          </p>
          <pre className="bg-[var(--bg-deep)] p-2 rounded border border-[var(--glass-border)] font-mono text-[10px] text-white">
            GITORCH_API_KEY=sua_chave_acima
          </pre>
          <p className="leading-relaxed">
            Isto garantirá que os agentes executando nas máquinas do GitHub consigam publicar
            relatórios no dashboard.
          </p>
        </div>
      </div>

      <div className="mt-auto pt-6 flex justify-center">
        <Link
          href="/painel"
          className="bg-white text-black px-8 py-4 rounded-full font-bold hover:scale-105 transition-transform flex items-center gap-2 shadow-[0_0_30px_rgba(255,255,255,0.15)]"
        >
          Ir para o Painel <ChevronRight size={18} />
        </Link>
      </div>
    </div>
  )
}
