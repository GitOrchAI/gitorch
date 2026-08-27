import type { F6AgentRole } from '@gitorch/agents'

/**
 * A passagem de bastão entre os papéis.
 *
 * MEDIDO na corrida cronometrada de 26/08: o desejo virou issue em UM segundo
 * e o RA acordou sozinho em TRÊS, pelo aviso do GitHub. E aí parou. O PO e o
 * SM precisaram ser forçados na mão, porque cada papel roda pela AGENDA e
 * ninguém chama o seguinte.
 *
 * Não era defeito de correção — era desenho. Mas é exatamente o que separa "a
 * esteira funciona" de "a esteira é contínua": com os agendamentos espaçados,
 * um desejo escrito de manhã só chega ao dev à tarde, passando por papéis que
 * já tinham o trabalho pronto e esperando.
 *
 * O desenho é o mesmo da fila de julgamento, que já resolveu o problema
 * gêmeo entre o SM e o QA: quem termina ENFILEIRA o seguinte, e o relógio
 * drena a fila com os tetos de orçamento e concorrência de sempre. Nunca se
 * chama motor direto, e uma recusa temporária DEVOLVE a vez em vez de perder
 * o trabalho.
 */

/**
 * Quem recebe o bastão de quem.
 *
 * O SM não passa adiante de propósito: quem acorda o QA é a fila de
 * julgamento, que já existe e tem regra própria (só entra entrega com pull
 * request sem parecer). Duas portas para o mesmo trabalho divergiriam em
 * silêncio, e a divergência apareceria como julgamento pedido para uma
 * entrega que o QA vai pular.
 */
export const PROXIMO_PAPEL: Partial<Record<F6AgentRole, F6AgentRole>> = {
  ra: 'po',
  po: 'sm',
}

export interface VezNaFila {
  papel: F6AgentRole
  projectId: string
}

export interface PassagemDeBastao {
  /** O papel terminou: enfileira quem vem depois, se houver. */
  passar: (papelQueTerminou: F6AgentRole, projectId: string) => void
  /** A próxima vez a ser acordada, ou nada quando a fila está vazia. */
  proxima: () => VezNaFila | undefined
  /** Recusa temporária: a vez volta para a fila. */
  devolver: (vez: VezNaFila) => void
  tamanho: () => number
}

export function criarPassagemDeBastao(): PassagemDeBastao {
  // A ordem de inserção do Set É a ordem da fila. Set, e não lista, porque o
  // mesmo papel e projeto repetido não pode virar fila de duplicatas: o RA
  // pode terminar duas vezes antes de o PO rodar, e acordar o PO duas vezes
  // para o mesmo projeto é motor gasto à toa.
  const esperando = new Set<string>()
  const chave = (v: VezNaFila) => `${v.papel}|${v.projectId}`

  return {
    passar(papelQueTerminou, projectId) {
      const seguinte = PROXIMO_PAPEL[papelQueTerminou]
      if (!seguinte) return
      esperando.add(chave({ papel: seguinte, projectId }))
    },
    proxima() {
      const primeira = esperando.values().next()
      if (primeira.done) return undefined
      esperando.delete(primeira.value)
      const [papel, projectId] = primeira.value.split('|')
      return { papel: papel as F6AgentRole, projectId: projectId as string }
    },
    devolver(vez) {
      esperando.add(chave(vez))
    },
    tamanho() {
      return esperando.size
    },
  }
}
