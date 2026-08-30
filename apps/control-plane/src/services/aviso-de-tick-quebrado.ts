import { decidirAvisoPorJanela, type EstadoDaJanela } from './aviso-por-janela.js'

/**
 * INCIDENTE DE 26/08/2026: a coluna `missions.waiting_status` não existia e o
 * scheduler estourava P2022 a cada tique, dentro de `processSetupMissions` —
 * uma exceção que não tem try/catch próprio e propaga até o `.catch()` global
 * do `setInterval` em scheduler.ts. O processo sobrevivia (não é crash, é uma
 * Promise rejeitada e logada), então NRestarts nunca subia; e o erro não
 * grava linha em `missions` (acontece antes de qualquer `mission.update`),
 * então o watchdog de "missões falhadas" também não pegava. Ochou-se
 * silencioso pelos dois lados: 80 minutos de esteira morta, ninguém avisado.
 *
 * `conferirBancoNoArranque` (banco-atrasado.ts) fecha o caso mais comum — o
 * ledger atrasado bem no BOOT do processo. Este arquivo fecha o resto: um
 * tique que rejeita, e continua rejeitando, DEPOIS que o processo já subiu
 * (banco ficou indisponível por um instante, uma migração nova quebrou algo
 * que a checagem do arranque não cobre, qualquer erro recorrente). Mesmo
 * padrão "avisa uma vez por janela, silêncio depois, limpa quando volta" que
 * `avisarSeTravadaPorVaga` já usa — só que sem persistir em `events`: um
 * restart do processo já reavalia do zero (e, com o deploy agora aplicando o
 * ledger antes de subir, um restart tende a ser justamente o que resolve).
 */

export interface DecisaoDeAvisoDeTick {
  novoEstado: EstadoDaJanela
  /** `null` quando não há nada a avisar nesta passagem. */
  mensagem: string | null
}

export function decidirAvisoDeTickQuebrado(
  estado: EstadoDaJanela,
  falhouAgora: boolean,
  agora: Date,
  minutosAteAlertar: number,
  erroAtual: string | null
): DecisaoDeAvisoDeTick {
  const decisao = decidirAvisoPorJanela(estado, falhouAgora, agora, minutosAteAlertar)
  if (!decisao.deveAvisar) {
    return { novoEstado: decisao.novoEstado, mensagem: null }
  }
  const linhas = [
    `GitOrch: o relógio interno (scheduler) está falhando repetidamente há ${decisao.minutosNoProblema} min — nenhuma tarefa automática está rodando.`,
  ]
  if (erroAtual) linhas.push('', `Último erro: ${erroAtual}`)
  linhas.push(
    '',
    'Se o erro falar de coluna ou tabela que não existe, rode na máquina do GitOrch:',
    '  cd apps/control-plane && bash scripts/db-migrate.sh',
    '',
    'Se não for isso, veja os logs do serviço: journalctl -u gitorch-control-plane -n 50'
  )
  return { novoEstado: decisao.novoEstado, mensagem: linhas.join('\n') }
}
