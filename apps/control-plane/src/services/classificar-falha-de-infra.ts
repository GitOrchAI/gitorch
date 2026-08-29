// Classifica UMA falha de infra do repositório do cliente. Regra PURA — sem
// rede. É o que separa "o CI do cliente quebrou" (vira trabalho para o RA→PO)
// de "o encanamento do GitOrch falhou" (bug nosso), de "o Dependabot travou"
// (config), de "workflow morto" (ignora).
//
// POR QUE isto existe (medido 29/08): o sensor tratava TODA rodada que já
// falhou uma vez como um incidente novo, misturando cinco coisas diferentes e
// abrindo ~20 issues duplicadas.

import { ehScaffoldingDoGitorch } from './scaffolding-do-gitorch.js'

export type ClasseDeFalha =
  | 'ci-do-cliente'
  | 'config-de-actions'
  | 'dependabot-travado'
  | 'alerta-de-seguranca'
  | 'scaffolding-do-gitorch'
  | 'workflow-morto'

export interface RunDeWorkflow {
  /** `.github/workflows/ci.yml` | `dynamic/dependabot/dependabot-updates` | ... */
  path: string
  /** Evento que disparou ESTA run (`push` | `pull_request` | `schedule` | `dynamic` | ...). */
  event: string
  /** Só para exibição — NUNCA para identidade (o Dependabot muda toda rodada). */
  name: string
}

export interface MetaDoWorkflow {
  /** `active` | `disabled_manually` | `disabled_inactivity` | ... */
  state?: string
  /** Quando rodou pela última vez (ISO). Ausente/muito antigo = candidato a morto. */
  ultimaRunEm?: string
}

/** Além de quantos dias sem rodar um workflow ainda-`active` conta como morto. */
export const DIAS_SEM_RODAR_ATE_MORTO = 30

export function classificarFalhaDeInfra(
  run: RunDeWorkflow,
  meta: MetaDoWorkflow,
  contextosQueTravamMerge: string[],
  conteudoDoWorkflow?: string
): ClasseDeFalha {
  // 1. Job interno do Dependabot — nem é "workflow", é o updater. Sem API de log.
  if (run.path.startsWith('dynamic/dependabot/')) return 'dependabot-travado'

  // 2. Workflow desativado, ou ativo mas sem rodar há muito tempo → morto.
  if (meta.state && meta.state !== 'active') return 'workflow-morto'
  if (meta.ultimaRunEm) {
    const diasParado = (Date.now() - new Date(meta.ultimaRunEm).getTime()) / (24 * 60 * 60 * 1000)
    if (Number.isFinite(diasParado) && diasParado > DIAS_SEM_RODAR_ATE_MORTO)
      return 'workflow-morto'
  }

  // 3. Encanamento do GitOrch — bug nosso, não do cliente.
  if (ehScaffoldingDoGitorch(run.path, conteudoDoWorkflow)) return 'scaffolding-do-gitorch'

  // 4. É o CI de verdade do cliente? Sinal forte: um check que a proteção do
  //    branch EXIGE, ou um workflow que roda em push/pull_request (o gate).
  const base = run.path.split('/').pop() ?? run.path
  const travaMerge = contextosQueTravamMerge.some(
    (c) => base.includes(c) || c.includes(base.replace(/\.ya?ml$/, ''))
  )
  const eventoDeGate = run.event === 'push' || run.event === 'pull_request'
  if (travaMerge || eventoDeGate) return 'ci-do-cliente'

  // 5. O resto: workflow do cliente mas fora do caminho de merge — config de
  //    Actions (schedule, workflow_dispatch, deploy manual...).
  return 'config-de-actions'
}
