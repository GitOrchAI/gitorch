/**
 * Uma acordada por papel e projeto em cada passada da vigília.
 *
 * MEDIDO AO VIVO em 26/08, entre 21:05 e 21:28: TODA passada do QA nascia
 * duplicada — mesmo projeto, mesmo papel, mesmo motor, menos de um segundo
 * entre elas (21:27:42.848 e 21:27:43.614; 21:16:42.755 e 21:16:43.447;
 * 21:06:37.445 e 21:06:38.162). Num tique o gitorch chegou a disparar QUATRO
 * (21:05:38.226, 38.947, 39.769, 40.595) — e as quatro devolveram exatamente
 * o mesmo "QA: no delegated PR awaiting judgment".
 *
 * A causa é o desenho do laço: a vigília percorre SESSÃO POR SESSÃO e chama
 * `dispararMissao('qa', projectId)` de dentro do laço (três pontos diferentes
 * em session-watch.ts). Com N sessões trazendo novidade, saem N missões — mas
 * a missão de QA não é por sessão: ela já recebe TODAS as sessões do projeto
 * e julga o conjunto. A segunda em diante nunca teve trabalho próprio.
 *
 * Dois prejuízos, e o segundo é o grave:
 *
 * 1. DESPERDÍCIO — paga-se de duas a quatro vezes a mesma pergunta ao motor.
 *    É o que explica 134 missões de QA "completas" num dia no gitorch, quase
 *    todas sem nada para julgar.
 *
 * 2. QUEIMA DE CREDENCIAL — o refresh token do Codex é de USO ÚNICO. Duas
 *    missões materializam a MESMA credencial no mesmo segundo; a primeira
 *    renova e o provedor invalida o token velho; a segunda tenta com o token
 *    já morto e leva `Failed to refresh token: 401`. O produto derrubava o
 *    motor do próprio cliente.
 *
 * É o MESMO raciocínio que `passar-o-bastao.ts` já aplica na fila de bastão
 * ("acordar o PO duas vezes para o mesmo projeto é motor gasto à toa"), num
 * lugar que nunca recebeu o tratamento.
 *
 * NÃO substitui serializar o USO da credencial: duas missões de origens
 * diferentes ainda podem se cruzar, e a trava de `trava-de-renovacao.ts`
 * cobre só a DEVOLUÇÃO ao cofre, não a leitura. Isto tira a causa dominante;
 * a trava de uso é tarefa à parte.
 */

export type Disparo = (papel: 'qa' | 'sm', projectId: string) => Promise<void>

/**
 * Embrulha o disparo de missão para que o MESMO papel e projeto só acorde uma
 * vez por passada.
 *
 * O gate é criado A CADA passada, de propósito: ele não é um teto de
 * frequência (isso é o descanso e a agenda), é só a garantia de que UM laço
 * sobre sessões não vire uma rajada. Na passada seguinte tudo pode disparar de
 * novo, como sempre pôde.
 */
export function umaAcordadaPorCiclo(disparar: Disparo): Disparo {
  const jaDisparado = new Set<string>()
  return async (papel, projectId) => {
    const chave = `${papel}|${projectId}`
    if (jaDisparado.has(chave)) return
    jaDisparado.add(chave)
    await disparar(papel, projectId)
  }
}
