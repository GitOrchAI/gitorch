/**
 * A sessão de trabalho que o dev externo abriu e nunca terminou.
 *
 * Medido em 24/08: dezenove linhas em `IN_PROGRESS` sem fechar, SETE delas sem
 * qualquer progresso havia NOVENTA horas. O teto do plano é quinze
 * simultâneas, então a folga ia a zero e o SM respondia "voltou vazio" e
 * dormia meia hora — com dezenas de tarefas prontas esperando. A esteira
 * inteira parava por vaga ocupada por trabalho que já tinha morrido.
 *
 * A drenagem de vagas vazadas (`reconciliar-vagas.ts`) NÃO pega este caso: ela
 * arquiva a vaga que não tem sessão nenhuma do outro lado. Aqui a sessão
 * existe — o dev é que nunca a conclui. São defeitos irmãos e correções
 * diferentes.
 *
 * Este arquivo é a REGRA, sem banco e sem rede.
 */

/**
 * Sem progresso por este tempo, a sessão é dada como abandonada.
 *
 * Doze horas porque o dev externo é assíncrono e legitimamente demora: uma
 * entrega grande passa da hora, atravessa a madrugada, volta. Meio dia sem
 * NENHUM sinal já não é lentidão — as sete que travaram a esteira estavam
 * paradas havia noventa.
 */
export const HORAS_SEM_PROGRESSO_ATE_ABANDONAR = 12

/**
 * Teto por varredura. Uma correção de relógio, ou a primeira varredura depois
 * de um acúmulo, não pode fechar tudo de uma vez sem ninguém ver — o mesmo
 * cuidado que a drenagem de vagas já tem.
 */
export const TETO_POR_VARREDURA = 25

/** Só o que a decisão precisa de uma linha de sessão. */
export interface LinhaParaJulgar {
  sessionName: string
  issueNumber: number
  state: string
  /** Último sinal de vida do trabalho. Pode faltar em linha antiga. */
  lastProgressAt: Date | null
  /** Quando a linha nasceu — o recuo quando nunca houve progresso. */
  createdAt: Date | null
  closedAt: Date | null
}

/**
 * Estados que ainda podem andar sozinhos. Só eles são candidatos: uma linha já
 * concluída ou falhada não é "abandonada", e chamá-la assim embaralharia o que
 * aconteceu de verdade com aquela entrega.
 */
const ESTADOS_QUE_AINDA_TRABALHAM = new Set(['QUEUED', 'IN_PROGRESS', 'AWAITING_USER_FEEDBACK'])

/**
 * Quais linhas estão abandonadas, na ordem da mais parada para a menos.
 *
 * A ordem importa quando o teto corta: fechar primeiro as que estão paradas há
 * mais tempo devolve as vagas mais seguras.
 */
export function sessoesAbandonadas(args: {
  linhas: LinhaParaJulgar[]
  agora: Date
  horasSemProgresso?: number
  teto?: number
}): LinhaParaJulgar[] {
  const limiteMs = (args.horasSemProgresso ?? HORAS_SEM_PROGRESSO_ATE_ABANDONAR) * 60 * 60 * 1000
  const teto = args.teto ?? TETO_POR_VARREDURA

  const paradas: Array<{ linha: LinhaParaJulgar; paradaHa: number }> = []
  for (const linha of args.linhas) {
    // Linha já fechada não tem vaga para devolver.
    if (linha.closedAt) continue
    if (!ESTADOS_QUE_AINDA_TRABALHAM.has(linha.state)) continue

    const ultimoSinal = linha.lastProgressAt ?? linha.createdAt
    // Sem NENHUMA data não dá para dizer que está parada. "Não sei" nunca pode
    // virar "está velha": fechar por ignorância jogaria fora o trabalho do dev.
    if (!ultimoSinal) continue
    const quando = ultimoSinal.getTime()
    if (!Number.isFinite(quando)) continue

    const paradaHa = args.agora.getTime() - quando
    // Relógio adiantado no registro produz diferença negativa. Isso é
    // "acabou de acontecer", nunca "muito tempo atrás".
    if (paradaHa <= limiteMs) continue

    paradas.push({ linha, paradaHa })
  }

  return paradas
    .sort((a, b) => b.paradaHa - a.paradaHa)
    .slice(0, teto)
    .map((p) => p.linha)
}
