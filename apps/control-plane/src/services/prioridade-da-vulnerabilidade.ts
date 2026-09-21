// Fase 5.2: grave (critical/high) em código de PRODUÇÃO (runtime) vai para a
// sprint atual — o resto (baixa gravidade, ou runtime não confirmado como
// dev-only) vai para o backlog. Escopo desconhecido trata como runtime: o
// lado seguro nunca subestima risco por falta de dado (mesma disciplina de
// 'severidade-desconhecida' em security-debt-collector.ts).

import type { Severidade } from './security-debt-collector.js'

export type EscopoDaVulnerabilidade = 'runtime' | 'development' | 'desconhecido'

const GRAVE: readonly Severidade[] = ['critical', 'high']

export function prioridadeDaVulnerabilidade(alerta: {
  severidade: Severidade
  escopo: EscopoDaVulnerabilidade
}): 'sprint-atual' | 'backlog' {
  const afetaProducao = alerta.escopo !== 'development'
  return GRAVE.includes(alerta.severidade) && afetaProducao ? 'sprint-atual' : 'backlog'
}
