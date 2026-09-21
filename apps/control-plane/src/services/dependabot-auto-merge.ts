// Fase 5.3: Dependabot com correção pronta (CI verde, sem conflito) mescla
// sozinho quando cuidaPorOrigem.dependabot === 'sim'. Caminho PRÓPRIO — não
// passa por decidirProximoPasso (Tarefa 3.5), que trata TODO PR do
// Dependabot como "automação sem conserto" (não há sessão para retomar).
// Aqui não há conserto: só a decisão de mesclar ou deixar quieto.

import type { EstadoDaVerificacao } from './vigia-do-pr.js'
import type { PoliticaDeCuidado } from './cuidado-por-origem.js'

export function decidirMergeDoDependabot(deps: {
  politica: PoliticaDeCuidado
  verificacao: EstadoDaVerificacao
  mergeable: boolean | null
}): { mesclar: boolean; motivo: string } {
  if (deps.politica !== 'sim') {
    return {
      mesclar: false,
      motivo: `configuração do Dependabot é "${deps.politica}", não mescla sozinho`,
    }
  }
  if (deps.verificacao !== 'verde') {
    return { mesclar: false, motivo: `verificação não está verde (${deps.verificacao})` }
  }
  if (deps.mergeable !== true) {
    return {
      mesclar: false,
      motivo: 'há conflito ou o GitHub ainda não confirmou que dá para mesclar',
    }
  }
  return { mesclar: true, motivo: 'Dependabot configurado para cuidar sozinho, verificação verde' }
}
