// O que fazer com a sessão do dev assíncrono que o Jules já deu como
// CONCLUÍDA ou FALHADA. Regra PURA — sem rede, sem banco.
//
// POR QUE isto existe (medido ao vivo 29/08/2026): 21 de 23 sessões da conta
// estavam em COMPLETED/FAILED e NENHUMA era fechada do lado do GitOrch. A
// varredura de abandono (`sessao-abandonada.ts`) pula esses estados de
// propósito ("uma linha já concluída ou falhada não é abandonada"), e a vigia
// (`vigiarSessoes`) nunca os fecha. Linha terminal com PR que não mescla = vaga
// imortal — e foi isso que parou a esteira dos dois projetos.
//
// LEI D51 (decisão do dono 29/08): a sessão morta NUNCA é abandonada de vez —
// a esteira sempre tenta de novo. Toda saída daqui, quando não é "manter", é
// FECHAR (devolve a vaga na hora) + alguma forma de retomada:
//  - `fechar-concluido`      → a entrega mesclou; caminho feliz.
//  - `fechar-e-redelegar`    → a issue volta para a fila no ciclo seguinte.
//  - `fechar-e-analisar`     → 2ª falha na MESMA issue: entende POR QUE antes da
//                              3ª tentativa (a análise ajusta o próximo pedido).

import { ehTerminal } from './estados-de-sessao.js'
import { ehMarcaDeEscalada } from './pergunta-sem-resposta.js'
import type { MotivoDeFechamento } from './dev-session-store.js'

/** Quanto tempo esperar um PR aberto-e-reprovado ganhar commit novo antes de
 *  desistir dele. O dev pode legitimamente demorar a retrabalhar. */
export const HORAS_ATE_DESISTIR_DO_PR_REJEITADO = 12

/** Na 2ª vez que a MESMA issue volta morta, roda a análise antes de tentar de
 *  novo. `requeueCount` conta quantas vezes a issue já foi redelegada. */
export const REQUEUE_ATE_ANALISAR = 2

/**
 * Situação do pull request da sessão, lida pelo chamador (via GitHub) e passada
 * para cá — a regra não toca rede.
 *  - `sem-pr`                   : a sessão terminou sem abrir PR.
 *  - `aberto-vivo`              : PR aberto, ainda no fluxo normal do QA.
 *  - `aberto-rejeitado-parado`  : PR aberto, o último parecer nosso é "mudar",
 *                                 e o dev não empurrou commit novo.
 *  - `fechado-sem-merge`        : PR foi fechado sem mesclar (descartado).
 *  - `mesclado`                 : PR mesclado.
 */
export type SituacaoDoPr =
  'sem-pr' | 'aberto-vivo' | 'aberto-rejeitado-parado' | 'fechado-sem-merge' | 'mesclado'

export type DecisaoTerminal =
  | { acao: 'manter' }
  | { acao: 'fechar-concluido'; motivo: 'merged' }
  | { acao: 'fechar-e-redelegar'; motivo: MotivoDeFechamento }
  | { acao: 'fechar-e-analisar'; motivo: MotivoDeFechamento }
  /**
   * L4-T5: PR aberto, reprovado, o dev não vai retomar sozinho (terminal) —
   * mas HÁ um ramo para retomar nele. Em vez de fechar às cegas e devolver a
   * issue para a fila (que abriria um SEGUNDO pull request — medido: issue
   * #3884, 5 sessões e 3 PRs para uma task), a esteira tenta de novo NO
   * MESMO PR. O teto de tentativas e a escalada ao dono, quando ele bate,
   * vivem em `retomarPrReprovado` (retomar-pr-reprovado.ts) — aqui só se
   * decide que HÁ o que retomar.
   */
  | { acao: 'retomar-no-mesmo-pr'; branchDoPr: string }

export function decidirSessaoTerminal(args: {
  estado: string
  situacaoDoPr: SituacaoDoPr
  /** Quantas vezes ESTA issue já foi redelegada por entrega que não mesclou. */
  requeueCount: number
  /** A análise de "por que o Jules falhou nesta issue" já rodou? */
  analiseJaFeita: boolean
  /** Há quantas horas a sessão está terminal (≈ agora − último sinal de avanço). */
  horasNoTerminal: number
  /**
   * L4-T5: o ramo do PR reprovado, quando dá para retomar nele
   * (`branchParaRetomar`, vigia-do-pr.ts — `null` para fork ou ramo
   * desconhecido). Só é OLHADO quando `situacaoDoPr === 'aberto-rejeitado-parado'`
   * e as 12h já passaram; `undefined` (chamador que ainda não sabe o ramo)
   * preserva o comportamento antigo (fecha e redelega, nunca retoma no mesmo
   * PR) — nenhum chamador existente quebra por não conhecer este campo.
   */
  branchRetomavel?: string | null
  /**
   * A marca de `pergunta-sem-resposta.ts` guardada em `DevSession.answeredHash`.
   *
   * L4-T4, fix-up 5 (task a13a42f8-2953-4259-b41f-3f8cddb304cd) — PROVADO em
   * produção 03/09: 2 sessões com dúvida ESCALADA ao dono (`escalada:0:<hash>`)
   * foram fechadas por este passo (`pr-rejeitado-sem-retomada`) ANTES de o
   * dono responder. `estado` (`args.estado` acima) É o `state` remoto do
   * Jules, sincronizado por `varrerSessoesDoDev` ANTES deste passo rodar, no
   * MESMO tique (scheduler.ts) — o Jules pode marcar a sessão como
   * COMPLETED/FAILED/CANCELLED mesmo com a dúvida ainda sem decisão do dono,
   * e quando isso acontece `estado` já não é mais AWAITING_USER_FEEDBACK: o
   * filtro `ehTerminal(state)` (fix-up 2) não segura nada, porque o próprio
   * `state` mudou. A ÚNICA fonte confiável de "o dono ainda não decidiu" é a
   * marca — independente de qual `estado`/`situacaoDoPr` chegou. Por isso o
   * veto abaixo é INCONDICIONAL: ignora `estado` de propósito (ao contrário
   * de `sessao-abandonada.ts`, cuja exceção é restrita a
   * AWAITING_USER_FEEDBACK por decisão deliberada do fix-up 3 — aqui o
   * `estado` já não é confiável, então checar só a marca é o único jeito
   * seguro).
   */
  answeredHash?: string | null
}): DecisaoTerminal {
  if (ehMarcaDeEscalada(args.answeredHash)) return { acao: 'manter' }
  if (!ehTerminal(args.estado)) return { acao: 'manter' }

  // Caminho feliz e caminho "ainda no QA": nada a fazer aqui.
  if (args.situacaoDoPr === 'mesclado') return { acao: 'fechar-concluido', motivo: 'merged' }
  if (args.situacaoDoPr === 'aberto-vivo') return { acao: 'manter' }

  // PR aberto e reprovado: o dev pode retrabalhar. Só desiste depois de dar
  // tempo — e o Jules estar terminal é a prova de que ele NÃO vai empurrar
  // commit novo sozinho (COMPLETED/FAILED não retomam por mensagem).
  if (
    args.situacaoDoPr === 'aberto-rejeitado-parado' &&
    args.horasNoTerminal < HORAS_ATE_DESISTIR_DO_PR_REJEITADO
  ) {
    return { acao: 'manter' }
  }

  // L4-T5: passou o tempo de espera e HÁ um ramo para retomar — a esteira
  // tenta de novo NO MESMO PR em vez de fechar e devolver a issue à fila.
  if (args.situacaoDoPr === 'aberto-rejeitado-parado' && args.branchRetomavel) {
    return { acao: 'retomar-no-mesmo-pr', branchDoPr: args.branchRetomavel }
  }

  const motivo: MotivoDeFechamento =
    args.situacaoDoPr === 'fechado-sem-merge'
      ? 'pr-descartado'
      : args.situacaoDoPr === 'aberto-rejeitado-parado'
        ? 'pr-rejeitado-sem-retomada'
        : args.estado.toUpperCase() === 'FAILED'
          ? 'dev-falhou'
          : 'dev-concluiu-sem-entrega'

  if (args.requeueCount >= REQUEUE_ATE_ANALISAR && !args.analiseJaFeita) {
    return { acao: 'fechar-e-analisar', motivo }
  }
  return { acao: 'fechar-e-redelegar', motivo }
}
