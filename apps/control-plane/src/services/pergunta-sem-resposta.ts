import { MAX_NUDGES } from './jules-session-loop.js'

/**
 * A pergunta do dev assíncrono que ficou sem resposta.
 *
 * MEDIDO AO VIVO em 26/08: treze sessões presas em AWAITING_USER_FEEDBACK, a
 * mais antiga desde 19 — sete dias — TODAS marcadas no banco como se já
 * tivessem sido respondidas. Nenhuma tinha.
 *
 * A causa era a ordem: a vigília gravava a marca da pergunta e SÓ DEPOIS
 * disparava a missão que responde. Quando a missão falhava — e naquele período
 * todas falhavam, porque a imagem do agente não existia na máquina — a
 * pergunta ficava marcada como respondida PARA SEMPRE, e o `break` do ciclo
 * seguinte fechava a porta. A sessão morria esperando.
 *
 * Inverter a ordem não resolve: o disparo é disparo-e-esquece, então a missão
 * pode falhar depois de a marca já ter sido gravada de qualquer jeito. O que
 * resolve é a marca deixar de significar "já respondi" e passar a significar
 * "já TENTEI responder esta pergunta" — com teto.
 *
 * O preço de errar isto é alto dos dois lados: sem retentativa, a sessão
 * congela uma vaga para sempre e o teto de simultâneas estoura, parando a
 * esteira inteira; sem teto, vira laço infinito gastando motor numa pergunta
 * que talvez ninguém consiga responder.
 */
export function deveTentarResponderDeNovo(args: {
  /** A pergunta que está na mesa agora. */
  hashDaPergunta: string
  /** A última pergunta para a qual já se tentou responder. */
  answeredHash: string | null
  /** Quantas tentativas esta linha já consumiu. */
  nudges: number
}): boolean {
  // Pergunta diferente da última: é conversa nova, e conversa nova sempre
  // merece resposta. O teto NUNCA se aplica aqui — um diálogo longo e legítimo
  // (o dev pergunta, recebe, pergunta outra coisa) não pode ser confundido com
  // uma pergunta que ficou sem resposta.
  if (args.hashDaPergunta !== args.answeredHash) return true

  // Mesma pergunta ainda na mesa: ou a resposta não saiu, ou não resolveu.
  // Tenta de novo enquanto houver teto.
  return args.nudges < MAX_NUDGES
}
