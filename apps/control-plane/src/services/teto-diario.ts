import type { F6AgentRole } from '@gitorch/agents'

// "Este papel pode ser segurado pelo teto de missões do dia?"
//
// O teto existe para proteger a máquina (e a cota do cliente) de um relógio
// desgovernado. Ele nasceu contando todo mundo igual — e foi assim que, em
// 20/08/2026, ele calou exatamente quem NÃO podia ser calado.
//
// O que aconteceu: o teto de 24 foi atingido às 17h, gasto pelos papéis de
// planejamento. Das 17h à meia-noite o log repetiu, a cada minuto,
// "Failsafe da instância atingido (24/24); pulando qa" — SETE HORAS com cinco
// entregas prontas, verificação verde, e ninguém autorizado a julgá-las. O
// teto não economizou nada nesse período: só impediu que trabalho já pago
// virasse entrega.
//
// Decisão do dono (D25, 21/08/2026): julgar é o passo que transforma trabalho
// em entrega e não pode ser o primeiro a cair quando a cota aperta.
//
// Três coisas que este módulo deliberadamente NÃO faz:
//
// 1. Não remove o teto. Os papéis que INICIAM trabalho novo continuam presos a
//    ele — a proteção segue inteira do lado que importa.
// 2. Não some com a missão da contagem. Uma missão de julgamento existe e gasta
//    recurso, então continua somando no total do dia e continua empurrando o
//    teto para os outros papéis. O que muda é só que ela não é BLOQUEADA por
//    ele. Mascarar a contagem seria mentir para o próprio failsafe.
// 3. Não mexe no teto de CONCORRÊNCIA. Quantas missões rodam ao mesmo tempo é
//    a proteção de memória da máquina, e ela continua valendo para o
//    julgamento como para todo mundo.

/**
 * O papel que julga a entrega e libera a mesclagem. Fora do teto diário por
 * decisão do dono — é o único passo cuja ausência transforma trabalho pronto
 * em trabalho perdido.
 */
const PAPEL_QUE_NAO_E_SEGURADO: F6AgentRole = 'qa'

export function tetoDiarioBloqueia(args: {
  role: F6AgentRole
  /** Missões que já contaram no dia (já descontadas as falhas de credencial). */
  usadasHoje: number
  teto: number
}): boolean {
  if (args.role === PAPEL_QUE_NAO_E_SEGURADO) return false
  return args.usadasHoje >= args.teto
}
