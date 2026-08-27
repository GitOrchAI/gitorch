/**
 * A credencial renovada NUNCA se perde.
 *
 * O PEDIDO DO DONO, 27/08, depois de religar o Codex pela segunda vez em um
 * dia: "sobre codex, pq religar de novo? precisa urgentemente resolver esse
 * problema de perder conexão com o codex!". Ele está certo — o produto estava
 * destruindo a credencial dele sozinho.
 *
 * COMO A CONEXÃO MORRIA, apurado no código (não suposto):
 *
 * O refresh token do Codex é de USO ÚNICO — usar uma vez invalida a anterior.
 * O CLI renova sozinho quando é chamado, então o HOME temporário da missão
 * termina com a credencial NOVA, e o cofre com a VELHA (já invalidada). A
 * devolução ao cofre é o que fecha esse ciclo.
 *
 * A trava de renovação (PR #274) tinha uma saída fatal: quando a trava estava
 * ocupada, o código PULAVA a devolução e apagava o HOME logo em seguida, com
 * o comentário "a próxima missão captura". Para token rotativo isso é
 * exatamente o contrário: a credencial nova ia para o lixo junto com o HOME, e
 * o cofre continuava servindo a velha — que o provedor já tinha invalidado.
 * A próxima missão pegava um token morto e levava 401. Não havia volta: a
 * conexão do cliente morria de vez, e só um login novo à mão resolvia.
 *
 * A REGRA, uma só: a devolução ESPERA a trava em vez de desistir dela. Nunca
 * se descarta o único token válido que existe.
 *
 * Por que não tentar adivinhar "esta missão falhou por credencial, então o
 * HOME dela é lixo e não deve voltar": o reconhecimento por texto tem falso
 * positivo conhecido e documentado (`ehCredencialExpirada` e os quatro casos
 * medidos em credencial-do-motor.ts). E aqui o falso positivo custa caro — ele
 * produz EXATAMENTE o descarte que este arquivo existe para impedir. Entre
 * regravar um token que já era e perder um recém-renovado, o segundo é o erro
 * grave; então, na dúvida, devolve.
 *
 * O que isto NÃO resolve: duas missões usando a MESMA credencial ao mesmo
 * tempo. Aí a segunda ainda pode regravar por cima da primeira. A saída de
 * verdade é serializar o USO da credencial, não a devolução — tarefa à parte,
 * e ela precisa de desenho próprio (a trava atual vale dois minutos e uma
 * missão dura mais). Este arquivo fecha o buraco que MATA; aquele fecha o que
 * atrapalha.
 */

/** Quanto tempo esperar pela trava antes de devolver assim mesmo. */
export const ESPERA_MAXIMA_PELA_TRAVA_MS = 30_000
const INTERVALO_DE_TENTATIVA_MS = 1_000

/**
 * Espera a vez de devolver — em vez de desistir e perder a credencial nova.
 *
 * Devolve `true` quando pegou a trava. Devolve `false` quando o tempo acabou —
 * e, mesmo aí, quem chama DEVE devolver do mesmo jeito: perder o único token
 * válido é pior que uma escrita concorrente, que no máximo regrava o mesmo
 * valor. O anterior fazia o contrário: desistia calado e matava a conexão.
 */
export async function esperarAVezDeDevolver(args: {
  pegar: () => Promise<boolean>
  esperar: (ms: number) => Promise<void>
  agora: () => number
  tetoMs?: number
}): Promise<boolean> {
  const teto = args.tetoMs ?? ESPERA_MAXIMA_PELA_TRAVA_MS
  const comeco = args.agora()
  for (;;) {
    if (await args.pegar()) return true
    if (args.agora() - comeco >= teto) return false
    await args.esperar(INTERVALO_DE_TENTATIVA_MS)
  }
}
