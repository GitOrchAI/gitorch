/**
 * O motor que morreu pedindo login descansa — e volta sozinho.
 *
 * DECISÃO DO DONO (D2, 20/08): "falha de autenticação não deve consumir vaga
 * do teto, e o produto deve avisar na primeira vez em vez de tentar 13 vezes".
 *
 * O que aconteceu: o antigravity estava deslogado desde 20/07 e o produto
 * seguiu disparando missão nele. Treze falhas queimaram metade da cota do dia,
 * o failsafe travou, e RA, PO e SM foram pulados 834 vezes em duas horas — a
 * esteira parada de 17 a 20/08 por causa de uma credencial vencida que ninguém
 * viu. Insistir num motor deslogado não produz nada: só gasta cota e faz
 * barulho.
 *
 * A pausa é de MEMÓRIA de propósito. Ela não pode exigir intervenção para se
 * desfazer, e o pior caso de perdê-la num reinício é uma tentativa a mais —
 * barato. Gravar no banco criaria o problema oposto: um motor marcado como
 * morto que ninguém desmarca, e aí o produto para de usar um motor que já
 * voltou. Já aconteceu neste projeto, com o banco dizendo `connected` para
 * motores vencidos havia semanas.
 *
 * Ela se desfaz de dois jeitos, e os dois sem ninguém pedir: qualquer sucesso
 * naquele motor apaga a marca na hora, e o tempo apaga sozinho, para o caso de
 * o dono religar sem que nenhuma missão tenha rodado.
 */

/**
 * Quanto tempo o motor morto fica de fora.
 *
 * Uma hora é o equilíbrio: curto o bastante para o motor religado voltar ao
 * rodízio sem ninguém pedir, e longo o bastante para não repetir o desperdício
 * a cada tique do relógio.
 */
export const DESCANSO_DO_MOTOR_MORTO_MS = 60 * 60_000

export interface MotorEmPausa {
  /** A credencial morreu: este motor sai do rodízio. */
  marcarMorto: (runtime: string, agora: Date) => void
  /** Um sucesso prova que voltou: a marca some na hora. */
  marcarVivo: (runtime: string) => void
  estaEmPausa: (runtime: string, agora: Date) => boolean
  /** Os motores da cadeia que ainda podem rodar. */
  filtrarCadeia: <T extends { runtime: string }>(cadeia: T[], agora: Date) => T[]
}

export function criarRegistroDeMotorMorto(descansoMs = DESCANSO_DO_MOTOR_MORTO_MS): MotorEmPausa {
  const mortoDesde = new Map<string, number>()

  const estaEmPausa = (runtime: string, agora: Date): boolean => {
    const desde = mortoDesde.get(runtime)
    if (desde === undefined) return false
    if (agora.getTime() - desde >= descansoMs) {
      // O tempo passou: o motor volta ao rodízio sem ninguém pedir. É o
      // caminho de volta para quem religou a credencial na mão.
      mortoDesde.delete(runtime)
      return false
    }
    return true
  }

  return {
    marcarMorto(runtime, agora) {
      // A primeira marca é a que vale: remarcar a cada falha esticaria o
      // descanso para sempre num motor que falha em rajada.
      if (!mortoDesde.has(runtime)) mortoDesde.set(runtime, agora.getTime())
    },
    marcarVivo(runtime) {
      mortoDesde.delete(runtime)
    },
    estaEmPausa,
    filtrarCadeia(cadeia, agora) {
      const vivos = cadeia.filter((m) => !estaEmPausa(m.runtime, agora))
      // Cadeia inteira em pausa devolve a original de propósito: ficar sem
      // motor nenhum seria parar a esteira por causa da própria proteção —
      // trocar um desperdício por uma paralisação. Melhor tentar e falhar.
      return vivos.length > 0 ? vivos : cadeia
    },
  }
}
