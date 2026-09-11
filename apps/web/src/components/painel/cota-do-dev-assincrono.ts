// A leitura de negócio de GET /api/v1/painel/dev-cota (DJ-T5), fora do React
// pelo mesmo motivo de painel-numeros.ts: o app web testa lógica em `.ts`
// (vitest, environment 'node'), e é isso que deixa cobrar por teste real que
// nenhum KPI vire número inventado.
//
// Pedido do dono: "só quero o meu gitorch usando o jules, sabendo quantas
// tarefas diárias tem disponível baseado no plano (meu é 100) e quantas estão
// sendo usadas pra próximas tarefas ficarem na esteira" — os 4 números que
// `linhasDaCotaDoDev` monta por conta: trabalhando agora, últimas 24h, tarefas
// esperando vaga, e a próxima vaga diária (só quando o teto está cheio).

import type { ContaDeCotaDoDev } from './painel-tipos'

export interface LinhaDaCotaDoDev {
  contaId: string | null
  /** Rótulo da conta na tela — os projetos que a dividem, ou nada quando é a única. */
  rotuloDaConta: string | null
  simultaneasTexto: string
  enviadas24hTexto: string
  prontasEsperandoVaga: number
  /** Nota da nota de "esperando vaga" — distingue "0 de verdade" de "ainda sem leitura". */
  notaDeEsperandoVaga: string
  /**
   * HH:MM em America/Sao_Paulo, só quando o teto diário está cheio
   * (`proximaVagaDiariaEm` não nulo). `null` = a tela NÃO desenha este KPI —
   * há vaga agora, prometer uma "próxima" seria enganoso.
   */
  proximaVagaHorario: string | null
}

/** HH:MM no fuso de São Paulo, a partir de um ISO 8601. */
export function horaEmSaoPaulo(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

/**
 * Monta as linhas exibíveis a partir do payload cru da rota. Uma linha por
 * conta — a maioria dos donos tem uma só, mas o teto é POR CONTA (BYOK, D34):
 * duas contas nunca são somadas na mesma linha.
 */
export function linhasDaCotaDoDev(contas: readonly ContaDeCotaDoDev[]): LinhaDaCotaDoDev[] {
  const maisDeUma = contas.length > 1
  return contas.map((c) => ({
    contaId: c.contaId,
    rotuloDaConta: maisDeUma ? c.projetos.join(', ') : null,
    simultaneasTexto: `${c.simultaneas} de ${c.tetoConcorrentes}`,
    enviadas24hTexto: `${c.enviadas24h} de ${c.tetoDiario}`,
    // `?? 0`: um control-plane antigo (sem DJ-T5 no ar) devolve a conta sem
    // este campo — undefined não pode virar um KPI em branco.
    prontasEsperandoVaga: c.prontasEsperandoVaga ?? 0,
    // `leituraDoSm !== 'ok'` (não `=== 'sem_leitura'`): um payload antigo, sem
    // o campo, é `undefined` — e undefined não é leitura confirmada. Testado
    // com o /dev-cota real de produção (11/09), que ainda não devolve este
    // campo: sem essa troca a tela afirmava "tarefas prontas na fila" com o
    // SM nunca tendo lido nada.
    notaDeEsperandoVaga: c.leituraDoSm !== 'ok' ? 'sem leitura ainda' : 'tarefas prontas na fila',
    // proximaVagaDiariaEm já vem null do servidor quando há folga — aqui só
    // traduz para horário; nunca calculamos "quando" no cliente (JANELA
    // ROLANTE já foi decidida no control-plane, com o relógio do servidor).
    proximaVagaHorario: c.proximaVagaDiariaEm ? horaEmSaoPaulo(c.proximaVagaDiariaEm) : null,
  }))
}
