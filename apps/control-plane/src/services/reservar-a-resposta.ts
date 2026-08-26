import { marcarTentativa } from './pergunta-sem-resposta.js'

/**
 * A reserva do direito de responder — antes de gastar motor.
 *
 * VISTO AO VIVO em 26/08, minutos depois do primeiro deploy da resposta ao
 * dev: uma sessão recebeu DUAS mensagens nossas no mesmo minuto. A causa era
 * ler-conferir-agir sem atomicidade — a função lia a sessão, conferia a marca,
 * chamava o motor (que demora), e só no fim gravava. Duas acordadas do QA na
 * mesma janela liam a MESMA marca antiga, as duas passavam pela conferência,
 * as duas chamavam o motor, e as duas escreviam na sessão.
 *
 * O estrago é duplo: o dev recebe a mesma resposta duas vezes — ruído dentro
 * do trabalho dele — e o produto gasta motor em dobro.
 *
 * A saída é a mesma que já resolveu a corrida de vagas de cota: escrita
 * CONDICIONAL à marca que foi lida. Quem escreve zero linhas perdeu a corrida
 * e sai calado, sem tocar em motor nenhum.
 */

export interface PrismaParaReserva {
  devSession: {
    updateMany: (args: {
      where: { sessionName: string; answeredHash: string | null }
      data: { answeredHash: string; stateCheckedAt?: Date }
    }) => Promise<{ count: number }>
  }
}

/**
 * Reserva o direito de responder ESTA pergunta.
 *
 * `true` = é sua, pode chamar o motor. `false` = outra acordada pegou primeiro;
 * saia sem fazer nada. A condição é a marca LIDA: se ela mudou entre a leitura
 * e agora, alguém passou na frente.
 */
export async function reservarAResposta(args: {
  prisma: PrismaParaReserva
  sessionName: string
  hashDaPergunta: string
  /** O número desta tentativa — é ele que segura o teto por pergunta. */
  tentativa: number
  /** A marca que estava lá quando a decisão foi tomada. */
  marcaLida: string | null
  agora: Date
}): Promise<boolean> {
  const resultado = await args.prisma.devSession.updateMany({
    where: { sessionName: args.sessionName, answeredHash: args.marcaLida },
    data: {
      answeredHash: marcarTentativa(args.hashDaPergunta, args.tentativa),
      stateCheckedAt: args.agora,
    },
  })
  return resultado.count > 0
}
