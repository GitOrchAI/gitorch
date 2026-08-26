/**
 * A pergunta do dev assíncrono que ficou sem resposta.
 *
 * MEDIDO AO VIVO em 26/08: treze sessões presas em AWAITING_USER_FEEDBACK, a
 * mais antiga desde 19 — sete dias — TODAS marcadas no banco como se já
 * tivessem sido respondidas. Nenhuma tinha. A vigília gravava a marca da
 * pergunta e SÓ DEPOIS disparava a missão que responde; quando a missão
 * falhava, a pergunta ficava marcada para sempre e a sessão morria esperando.
 *
 * A primeira correção trocou esse defeito por outro, achado numa revisão que
 * encadeou ciclos de verdade em vez de olhar uma passagem só — e os dois novos
 * eram piores:
 *
 * - o campo guardava DOIS significados que se sobrescreviam (o hash da
 *   pergunta pendente e a marca de "desisti desta"), então a cada ciclo o
 *   produto alternava entre os dois: tentava, desistia, achava que era
 *   pergunta nova, tentava de novo — motor queimado para sempre e o mesmo
 *   aviso chegando ao dono a cada dois ciclos;
 * - o teto vinha de um contador COMPARTILHADO com outros ramos da vigília,
 *   então o orçamento de uma pergunta era consumido por uma sessão travada
 *   sem relação nenhuma. Pior: o aviso ao dono dizia "tentei 3 vezes" quando
 *   tinha tentado uma. Isso é mentira, e mentira é o que este projeto não
 *   admite.
 *
 * A raiz dos dois era a mesma: um campo só, com significado ambíguo, e um
 * contador emprestado. A marca agora carrega TUDO o que a decisão precisa —
 * o que aconteceu, com qual pergunta, e quantas vezes se tentou ESTA. Nada é
 * inferido de fora, nada é emprestado.
 */

/**
 * Teto de tentativas POR PERGUNTA.
 *
 * Deliberadamente separado do contador geral de cutucadas da vigília: aquele é
 * consumido por sessão travada, pedido de retomada e investigação de falha, e
 * misturar os dois fazia o produto desistir de uma pergunta que mal tinha sido
 * tentada — e dizer ao dono um número que não aconteceu.
 */
export const MAX_TENTATIVAS_DE_RESPOSTA = 3

type Situacao = 'tentando' | 'respondida' | 'desisti'

interface MarcaLida {
  situacao: Situacao
  hash: string
  tentativas: number
}

/**
 * A marca guardada na linha da sessão.
 *
 * Formato `<situação>:<tentativas>:<hash>`. Feio de propósito: é um campo de
 * texto que já existia, e inventar tabela nova para três informações seria
 * caro sem ser mais honesto. O que importa é que a marca é AUTOSSUFICIENTE —
 * lida sozinha, ela responde "o que aconteceu com qual pergunta, e quantas
 * vezes" sem depender de nenhum contador de fora.
 */
export function marcarTentativa(hash: string, tentativas: number): string {
  return `tentando:${tentativas}:${hash}`
}

/** A resposta SAIU. Encerra o assunto: nem retentativa, nem motor, nem aviso. */
export function marcarRespondida(hash: string): string {
  return `respondida:0:${hash}`
}

/** Bateu o teto e o dono já foi avisado — uma vez, e não a cada ciclo. */
export function marcarDesistencia(hash: string, tentativas: number): string {
  return `desisti:${tentativas}:${hash}`
}

/**
 * Lê a marca. Formato desconhecido (ou marca de uma versão anterior) vira
 * "nunca vi esta pergunta" de propósito: é o padrão seguro — no pior caso o
 * produto tenta uma vez a mais, em vez de desistir de uma pergunta viva.
 */
export function lerMarca(bruto: string | null): MarcaLida | null {
  if (!bruto) return null
  const partes = bruto.split(':')
  if (partes.length < 3) return null
  const [situacao, tentativas, ...resto] = partes
  if (situacao !== 'tentando' && situacao !== 'respondida' && situacao !== 'desisti') return null
  const n = Number(tentativas)
  if (!Number.isInteger(n) || n < 0) return null
  return { situacao, hash: resto.join(':'), tentativas: n }
}

export type DecisaoSobreAPergunta =
  /** Tentar responder. `tentativa` é a contagem DESTA pergunta, para a marca. */
  | { acao: 'responder'; tentativa: number }
  /** Bateu o teto agora: avisa o dono UMA vez e marca a desistência. */
  | { acao: 'desistir'; tentativas: number }
  /** Nada a fazer: já respondida, ou já desistimos e o dono já sabe. */
  | { acao: 'nada'; motivo: string }

/**
 * O que fazer com a pergunta que está na mesa.
 *
 * Tudo sai da marca e do hash da pergunta atual — nenhum contador de fora,
 * nenhum estado ambíguo. É isso que impede a oscilação: a marca sempre carrega
 * COM QUAL pergunta ela fala, então "desisti desta" nunca mais é confundido
 * com "chegou uma pergunta nova".
 */
export function decidirSobreAPergunta(args: {
  hashDaPergunta: string
  marca: string | null
}): DecisaoSobreAPergunta {
  const lida = lerMarca(args.marca)

  // Pergunta diferente da que a marca descreve: conversa nova, e conversa nova
  // começa do zero. O teto NUNCA é herdado — um diálogo longo e legítimo (o
  // dev pergunta, recebe, pergunta outra coisa) não pode ser confundido com
  // uma pergunta que ninguém conseguiu responder.
  if (!lida || lida.hash !== args.hashDaPergunta) {
    return { acao: 'responder', tentativa: 1 }
  }

  if (lida.situacao === 'respondida') {
    return { acao: 'nada', motivo: 'esta pergunta já foi respondida' }
  }
  if (lida.situacao === 'desisti') {
    return { acao: 'nada', motivo: 'já desistimos desta pergunta e o dono já foi avisado' }
  }

  const proxima = lida.tentativas + 1
  if (proxima > MAX_TENTATIVAS_DE_RESPOSTA) {
    return { acao: 'desistir', tentativas: lida.tentativas }
  }
  return { acao: 'responder', tentativa: proxima }
}
