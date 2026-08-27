/**
 * O produto para de acreditar no que o banco diz sobre os motores.
 *
 * TERCEIRA vez que o projeto tropeça no mesmo lugar: a tabela dizia
 * 'connected' para três motores enquanto dois estavam vencidos havia semanas.
 * Foi essa mentira que fez o produto disparar treze missões contra um motor
 * morto e cair para uma "reserva" igualmente morta.
 *
 * POR QUE A CHECAGEM DE VIDA NUNCA PEGOU NADA entre 17 e 20/08 — apurado no
 * código, que era o primeiro passo desta tarefa: `checkLiveness` só roda dentro
 * de `captureFromHome`, ou seja, apenas quando alguém CAPTURA uma credencial
 * (login assistido e, agora, a renovação automática). Nunca houve conferência
 * periódica. Entre 17 e 20/08 ninguém capturou nada, então ninguém conferiu, e
 * a linha do banco seguiu repetindo o 'connected' escrito no dia da conexão.
 *
 * `status` responde "o que sabíamos quando alguém olhou". Esta função responde
 * outra pergunta, que é a que importa na hora de escolher um motor: "quando ele
 * respondeu pela ÚLTIMA VEZ?".
 */

/**
 * Quanto tempo uma prova de vida vale.
 *
 * Sete dias: mais curto e um motor legítimo pouco usado seria descartado à toa;
 * mais longo e volta o buraco que deixou um motor morto há vinte dias passando
 * por vivo — medido hoje, com a linha do antigravity dizendo 'connected' e a
 * última prova de vida sendo de 06/08.
 */
export const VALIDADE_DA_PROVA_DE_VIDA_MS = 7 * 24 * 60 * 60_000

export interface MotorComProva {
  runtime: string
  status: string
  /** Quando o motor RESPONDEU pela última vez — não quando a linha foi salva. */
  lastValidatedAt: Date | null
}

export type EstadoDoMotor =
  /** Respondeu recentemente: pode receber missão. */
  | { estado: 'vivo'; desde: Date }
  /** Diz estar conectado, mas ninguém o vê responder há tempo demais. */
  | { estado: 'sem-prova'; motivo: string }
  /** O banco já sabe que está quebrado. */
  | { estado: 'quebrado'; motivo: string }

/**
 * O estado REAL de um motor, e não o que a linha do banco afirma.
 *
 * Pura: mesma entrada, mesma saída, sem banco, sem rede, sem relógio próprio.
 */
export function estadoRealDoMotor(motor: MotorComProva, agora: Date): EstadoDoMotor {
  if (motor.status !== 'connected') {
    return { estado: 'quebrado', motivo: `a conexão está em "${motor.status}"` }
  }
  if (!motor.lastValidatedAt) {
    return {
      estado: 'sem-prova',
      motivo: 'nunca houve uma prova de vida deste motor',
    }
  }
  const idade = agora.getTime() - motor.lastValidatedAt.getTime()
  if (idade >= VALIDADE_DA_PROVA_DE_VIDA_MS) {
    return {
      estado: 'sem-prova',
      motivo: `a última vez que este motor respondeu foi há ${Math.floor(idade / 86_400_000)} dias`,
    }
  }
  return { estado: 'vivo', desde: motor.lastValidatedAt }
}

/**
 * Os motores que podem receber trabalho.
 *
 * Só quem PROVOU estar vivo. O failover caía para o próximo da lista sem
 * conferir nada — foi assim que ele trocou um motor morto por outro igualmente
 * morto, gastando a cota do dia em treze tentativas que não podiam dar certo.
 */
export function motoresComProvaDeVida<T extends MotorComProva>(
  motores: readonly T[],
  agora: Date
): T[] {
  return motores.filter((m) => estadoRealDoMotor(m, agora).estado === 'vivo')
}
