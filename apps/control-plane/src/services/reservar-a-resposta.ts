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
      data: { answeredHash: string | null; stateCheckedAt?: Date }
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

/**
 * DEVOLVE a reserva quando quem falhou foi o MOTOR, não a pergunta.
 *
 * O AVISO QUE O DONO RECEBEU (26/08 21:49): "o dev parou na tarefa #246 e eu
 * tentei responder 3 vezes sem conseguir. O trabalho está parado esperando
 * essa resposta." As três "tentativas" não tinham nada a ver com a pergunta:
 * as três morreram em `Individual quota reached` — o motor estava sem cota.
 *
 * O estrago não é o desperdício, é a PERDA PERMANENTE. A marca `desisti` não
 * tem volta (`decidirSobreAPergunta` devolve 'nada' para sempre), então uma
 * indisponibilidade de algumas horas condenava a pergunta: quando o motor
 * voltasse, ninguém jamais tentaria de novo, e o trabalho ficaria parado para
 * sempre esperando uma resposta que nunca viria.
 *
 * O teto de tentativas existe para uma coisa só: não insistir eternamente numa
 * dúvida que o produto não sabe responder. Uma tentativa, então, é "FORMULEI
 * uma resposta e ela não serviu". Motor sem cota não formulou nada — nenhuma
 * resposta chegou a existir para ser julgada. Contar as duas coisas no mesmo
 * número faz uma queda de infraestrutura gastar o orçamento inteiro de uma
 * pergunta viva.
 *
 * Condicional pela mesma razão que a reserva: só devolve se a marca no banco
 * ainda for a MINHA. Se outra acordada já escreveu por cima, ela é a dona
 * agora, e sobrescrever seria ressuscitar um estado que deixou de valer.
 */
export async function devolverAReserva(args: {
  prisma: PrismaParaReserva
  sessionName: string
  hashDaPergunta: string
  /** O número da tentativa que EU reservei — é ela que estou desfazendo. */
  tentativa: number
  /** A marca que existia ANTES da minha reserva; volta a valer. */
  marcaAnterior: string | null
  agora: Date
}): Promise<boolean> {
  const minhaMarca = marcarTentativa(args.hashDaPergunta, args.tentativa)
  const resultado = await args.prisma.devSession.updateMany({
    where: { sessionName: args.sessionName, answeredHash: minhaMarca },
    data: { answeredHash: args.marcaAnterior, stateCheckedAt: args.agora },
  })
  return resultado.count > 0
}
