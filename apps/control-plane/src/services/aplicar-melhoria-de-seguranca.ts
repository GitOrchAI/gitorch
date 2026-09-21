// Fase 5.4: aplica melhoria de segurança sozinho SÓ quando o plano do GitHub
// permite E autonomiaDeSeguranca === 'cuidar' (Tarefa 0.2). Quando não
// permite, a Fase 5.5 (alternativa-gratuita-de-seguranca.ts) assume.

import { podeEscrever, type NivelDeAutonomia } from '@gitorch/cadence'
import type { ChecksDeSeguranca } from './nota-de-seguranca.js'

export type PlanoDoGithub = 'free' | 'pro' | 'team' | 'enterprise'
export type Melhoria = keyof ChecksDeSeguranca | 'secret-scanning' | 'branch-protection'

export function planoPermiteMelhoria(
  melhoria: Melhoria,
  plano: PlanoDoGithub,
  repoPrivado: boolean
): boolean {
  if (!repoPrivado) return true // as duas são grátis em repositório público.
  if (melhoria === 'branch-protection' || melhoria === 'branchProtection') return plano !== 'free'
  // secret scanning AVANÇADO (bloqueio de push) exige GitHub Advanced
  // Security em repo privado — só Team/Enterprise com o add-on. Simplificado
  // aqui como team/enterprise; refinamento por add-on real fica para quando
  // a API expuser essa informação (hoje não expõe sem consulta de billing).
  if (melhoria === 'secret-scanning') return plano === 'team' || plano === 'enterprise'

  // Default to true for other check types since they don't have documented restrictions here
  return true
}

export interface AplicarMelhoriaDeps {
  repository: string
  melhoria: Melhoria
  plano: PlanoDoGithub
  repoPrivado: boolean
  autonomiaDeSeguranca: NivelDeAutonomia
  aplicar: () => Promise<void>
}

export async function aplicarMelhoriaDeSeguranca(
  deps: AplicarMelhoriaDeps
): Promise<{ aplicado: boolean; motivo: string }> {
  if (!planoPermiteMelhoria(deps.melhoria, deps.plano, deps.repoPrivado)) {
    return {
      aplicado: false,
      motivo: `o plano "${deps.plano}" do GitHub não permite ${deps.melhoria} neste repositório`,
    }
  }
  // A ação classificada é 'mesclar' (Step 1 confirmou) — o degrau mais alto
  // da autonomia GERAL, mas esta tarefa usa autonomiaDeSeguranca (Tarefa
  // 0.2), um campo PRÓPRIO. A checagem aqui é MANUAL (não via
  // guardaDeAutonomia, que lê `autonomia`, o campo geral) — exatamente
  // porque os dois campos podem divergir por desenho.
  const decisao = podeEscrever(deps.autonomiaDeSeguranca, 'mesclar')
  if (!decisao.pode) {
    return { aplicado: false, motivo: decisao.motivo }
  }

  try {
    await deps.aplicar()
  } catch (err) {
    const error = err as Error
    return { aplicado: false, motivo: `falha na API: ${error.message}` }
  }

  return {
    aplicado: true,
    motivo: `${deps.melhoria} aplicada — plano permite e autonomia de segurança é "cuidar"`,
  }
}
