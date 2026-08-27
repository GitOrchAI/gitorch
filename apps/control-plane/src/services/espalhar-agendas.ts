/**
 * Dois projetos não acordam o mesmo papel no mesmo minuto.
 *
 * MEDIDO NO BANCO em 26/08: os dois projetos (gitorch e patinhas-3d-crafts)
 * têm os quatro papéis agendados nos MESMOS horários — RA às 06:00 e 18:00, PO
 * às 03:00 e 15:00, SM às 05/11/17/23, QA às 00/08/16 — e o carimbo do último
 * disparo era idêntico até os milissegundos: os dois RA às 18:01:00.339.
 *
 * Isso seria inofensivo se cada projeto tivesse o próprio motor. Não tem: a
 * conta de motores é do DONO, não do projeto. Então os dois RA disputam o
 * mesmo motor no mesmo segundo, e quem chega depois encontra a cota que o
 * outro acabou de gastar. Com mais projetos, piora em linha reta.
 *
 * O conserto é o mais barato possível: cada projeto ganha um deslocamento
 * PRÓPRIO e estável dentro da janela, e as acordadas deixam de empilhar. Nada
 * de fila, nada de trava — só parar de marcar todo mundo para a mesma hora.
 *
 * O PAPEL entra na conta junto com o projeto de propósito. Com o
 * deslocamento vindo só do projeto, dois projetos azarados que caíssem no
 * mesmo número colidiriam nos QUATRO papéis, todo dia, para sempre. Misturando
 * o papel, um empate num papel não arrasta os outros.
 *
 * NÃO substitui contar o gasto de motor por CONTA (somando os projetos), que é
 * o que `conta-do-dev-externo.ts` já faz do lado do dev assíncrono. Espalhar
 * reduz a colisão; contar por conta é o que impede o estouro. São coisas
 * diferentes e a segunda é tarefa à parte.
 */

/**
 * O tamanho da janela de espalhamento, em minutos.
 *
 * Quinze: largo o bastante para separar acordadas que hoje caem no mesmo
 * segundo, e curto o bastante para ninguém sentir — um papel agendado para as
 * 06:00 roda entre 06:00 e 06:14, o que não muda nada para quem espera o
 * trabalho do dia.
 */
export const JANELA_DE_ESPALHAMENTO_MIN = 15

/**
 * Hash determinístico e estável (FNV-1a de 32 bits).
 *
 * Determinístico importa mais do que parecer aleatório: o mesmo projeto tem de
 * cair sempre no mesmo minuto, senão a agenda "anda" a cada reinício do
 * processo e ninguém consegue prever nem depurar quando um papel roda.
 */
function hashEstavel(texto: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** De quantos minutos é o atraso desta agenda. Sempre o mesmo para a mesma dupla. */
export function desvioDaAgenda(projectId: string, papel: string): number {
  return hashEstavel(`${projectId}|${papel}`) % JANELA_DE_ESPALHAMENTO_MIN
}

/**
 * O instante que a conferência da agenda deve usar.
 *
 * Recuar o relógio em N minutos é o mesmo que adiantar a agenda em N: o cron
 * continua escrito em hora redonda (é o que o dono lê e edita), e só a
 * conferência sabe do deslocamento. Escrever o desvio dentro do cron faria o
 * contrário — poluiria o dado do cliente com uma decisão nossa.
 */
export function relogioDaAgenda(agora: Date, projectId: string, papel: string): Date {
  return new Date(agora.getTime() - desvioDaAgenda(projectId, papel) * 60_000)
}
