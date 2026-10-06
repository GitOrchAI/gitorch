// Fase 5.2: grave (critical/high) que afeta o PRODUTO publicado (runtime) ou
// que já tem correção publicada vai para a sprint atual — o resto vai para o
// backlog. Escopo desconhecido trata como runtime: o lado seguro nunca
// subestima risco por falta de dado (mesma disciplina de
// 'severidade-desconhecida' em security-debt-collector.ts).

import type { Severidade } from './security-debt-collector.js'

export type EscopoDaVulnerabilidade = 'runtime' | 'development' | 'desconhecido'

export type DestinoDoAlerta = 'sprint-atual' | 'backlog' | 'sem-tarefa'

const GRAVE: readonly Severidade[] = ['critical', 'high']

export function prioridadeDaVulnerabilidade(alerta: {
  severidade: Severidade
  escopo: EscopoDaVulnerabilidade
  /** Ausente ou nulo = ainda não há versão que corrija. */
  versaoCorrigida?: string | null
}): 'sprint-atual' | 'backlog' {
  const afetaProducao = alerta.escopo !== 'development'
  const temCorrecao = Boolean(alerta.versaoCorrigida)
  return GRAVE.includes(alerta.severidade) && (afetaProducao || temCorrecao)
    ? 'sprint-atual'
    : 'backlog'
}

/**
 * Para onde o alerta vai, com o motivo em linguagem de quem lê a ficha.
 * Biblioteca só de desenvolvimento sem correção publicada não vira tarefa:
 * não afeta o produto no ar e não há o que atualizar ainda.
 */
export function destinoDoAlerta(alerta: {
  severidade: Severidade
  escopo: EscopoDaVulnerabilidade
  versaoCorrigida: string | null
}): { destino: DestinoDoAlerta; motivo: string } {
  const temCorrecao = Boolean(alerta.versaoCorrigida)
  if (alerta.escopo === 'development' && !temCorrecao) {
    return {
      destino: 'sem-tarefa',
      motivo:
        'biblioteca usada só em desenvolvimento e ainda sem correção publicada: não afeta o produto no ar e não há versão para atualizar',
    }
  }
  const ondeAfeta =
    alerta.escopo === 'runtime'
      ? 'usada em produção'
      : alerta.escopo === 'development'
        ? 'usada só em desenvolvimento'
        : 'sem confirmação de escopo (tratada como produção)'
  const correcao = temCorrecao
    ? `correção na versão ${alerta.versaoCorrigida}`
    : 'ainda sem correção publicada'
  const destino = prioridadeDaVulnerabilidade(alerta)
  const regra =
    destino === 'sprint-atual'
      ? 'grave, entra na sprint atual'
      : 'gravidade média ou baixa, vai para o backlog'
  return {
    destino,
    motivo: `${alerta.severidade}, biblioteca ${ondeAfeta}, ${correcao}: ${regra}`,
  }
}
