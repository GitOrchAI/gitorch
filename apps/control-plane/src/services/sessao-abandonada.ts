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

import { ehMarcaDeEscalada } from './pergunta-sem-resposta.js'

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
  /**
   * A marca de `pergunta-sem-resposta.ts` (`respondida:`/`desisti:`/
   * `escalada:`/`tentando:`). Opcional porque chamador antigo (e teste
   * antigo) não precisa saber disso — só entra na decisão quando `state` é
   * `AWAITING_USER_FEEDBACK` (ver `ehDuvidaEscaladaAoDono` abaixo).
   */
  answeredHash?: string | null
}

/**
 * A dúvida do dev que subiu de VERDADE ao dono (L4-T3, marca `escalada:` em
 * `answeredHash`) e ainda espera a decisão dele — ou a suposição do RA
 * (L4-T4/D64) depois de 24h em silêncio.
 *
 * MEDIDO em teste de costura real (fix-up desta task): como
 * HORAS_SEM_PROGRESSO_ATE_ABANDONAR (12h) é MENOR que o prazo de 24h que
 * aciona a suposição (`supor-duvida-pendente.ts`), sem esta exceção este
 * watchdog fechava a sessão como `abandoned` ANTES da suposição rodar — D64
 * nunca dispararia em produção. Só vale para `AWAITING_USER_FEEDBACK`: é o
 * único estado em que `escalada:` pode aparecer (quem escala é
 * `escalar-duvida-ao-dono.ts`, chamado só a partir desse estado).
 */
function ehDuvidaEscaladaAoDono(linha: LinhaParaJulgar): boolean {
  // C5 (fix-up 3): `ehMarcaDeEscalada` (pergunta-sem-resposta.ts) e' a fonte
  // UNICA desta checagem - antes, este arquivo e `session-watch.ts` faziam
  // `startsWith('escalada:')` cada um por conta propria, e uma marca
  // truncada (ex.: `escalada:` sem tentativas/hash) passaria aqui como
  // "escalada de verdade" sem nunca ter sido gravada por
  // `escalar-duvida-ao-dono.ts`.
  return linha.state === 'AWAITING_USER_FEEDBACK' && ehMarcaDeEscalada(linha.answeredHash)
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
    // D64 (deriva do dono) + L4-T3 (marca `escalada:`) + L4-T4 (a
    // suposição do RA, task a13a42f8-2953-4259-b41f-3f8cddb304cd): o
    // relógio de abandono PAUSA enquanto a dúvida estiver escalada ao dono —
    // só a resposta dele (`retomar-sessao-com-resposta.ts`) ou a suposição
    // do RA (`supor-duvida-pendente.ts`) tiram a sessão dali. Sessão
    // AWAITING sem marca de escalada continua com a regra de 12h de sempre.
    if (ehDuvidaEscaladaAoDono(linha)) continue

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
