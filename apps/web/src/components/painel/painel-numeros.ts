// Os números com nome de negócio da Visão Geral e da tela de Projetos.
//
// Moram fora do React de propósito: o app web testa lógica em `.ts` (vitest com
// environment 'node'), e era exatamente por estarem soltos dentro do .tsx que
// "Entregue no total: 4521" atravessou revisão com todos os testes verdes.
//
// O DEFEITO QUE ESTE MÓDULO CONSERTA (medido no banco em 31/08/2026): a Visão
// Geral anunciava 4521 entregas lendo `missions.status = 'completed'`, e no
// mesmo painel a aba Entregas dizia PRONTAS: 0. `missions` conta RODADA DE
// AGENTE — quantas vezes um agente rodou —, não entrega. A verdade pela régua
// do dono é 15 entregas prontas em 99 pedidos.
//
// A LEI (decisão do dono, D60): entrega é o INCREMENTO do Scrum — nasce quando
// um item atende à Definição de Pronto. Rodada de agente nunca é entrega. Daí
// a regra geral que este módulo carrega: NENHUM número com nome de negócio
// pode ser alimentado por contador interno.

import { rotuloDoDenominador } from './entregas-paginacao'

/**
 * Quem alimenta o número.
 *
 * Existe como campo, e não como comentário, porque é o que deixa a regra
 * acima ser TESTADA: dá para varrer os números da tela e cobrar que nenhum
 * marcado como 'rodadas' se chame de entrega.
 */
export type FonteDoNumero = 'entregas' | 'rodadas' | 'decisoes'

/**
 * O vocabulário de ENTREGA, que só a fonte 'entregas' tem direito de usar.
 *
 * Vale para o rótulo E para a nota. A nota antiga do "Travado" era "precisa de
 * revisão manual": mandava o dono revisar 477 entregas que não existiam, e o
 * número era de rodada de agente falha.
 */
export const PALAVRAS_DE_ENTREGA = /entreg|pront[ao]|tarefa|pedido/i

/** As contagens de `missions` — RODADA DE AGENTE, não entrega. */
export interface StatsDeRodadas {
  active: number
  completed: number
  failed: number
}

/**
 * O resumo de GET /api/v1/painel/entregas: `dev_sessions` agrupadas por PEDIDO
 * e julgadas pela régua do projeto (`avaliarPronto`, packages/cadence). MESMA
 * rota e MESMO filtro de projeto da aba Entregas — é o que faz os dois números
 * baterem em vez de se contradizerem na mesma tela.
 */
export interface ResumoDeEntregas {
  /**
   * Quantos PEDIDOS atendem à Definição de Pronto do cliente. `null` é
   * DESCONHECIDO: campo ausente vira travessão na tela, nunca zero.
   */
  prontas: number | null
  /**
   * De quantos PEDIDOS a conta saiu. `null` é DESCONHECIDO, não zero: se a
   * rota não mandar o campo, a nota some em vez de dizer "de 0".
   */
  total: number | null
}

export interface KpiView {
  l: string
  v: number | null
  n: string
  tone: string
  destaque?: boolean
  fonte: FonteDoNumero
}

/**
 * Os quatro números do topo da Visão Geral.
 *
 * `entregas: null` = ainda carregando (ou a rota falhou). Nesse caso o número
 * é `null` e a tela mostra travessão. Cair no contador de rodadas para "não
 * ficar vazio" é como o defeito nasceu.
 */
export function kpisDaVisaoGeral(args: {
  entregas: ResumoDeEntregas | null
  rodadas: StatsDeRodadas | null
  decisoesPendentes: number
}): KpiView[] {
  const { entregas, rodadas, decisoesPendentes } = args
  return [
    {
      l: 'Entregue no total',
      v: entregas ? entregas.prontas : null,
      // O mesmo texto da aba Entregas, vindo da mesma função: duas escritas do
      // denominador acabariam divergindo, e a divergência apareceria como duas
      // frases diferentes sobre a mesma população na mesma tela.
      n: entregas
        ? (rotuloDoDenominador(entregas.total) ?? 'pelo que a sua régua já julgou')
        : 'ainda carregando',
      tone: 'g',
      fonte: 'entregas',
    },
    {
      l: 'Esperando sua decisão',
      v: decisoesPendentes,
      n: decisoesPendentes ? 'responder destrava o trabalho' : 'nada pendente',
      tone: 'w',
      destaque: decisoesPendentes > 0,
      fonte: 'decisoes',
    },
    {
      // Era "Em andamento", que o dono lia como "pedidos meus em andamento".
      // É quantas vezes um agente está rodando agora — pode haver dez rodadas
      // do mesmo pedido.
      l: 'Rodadas de agente agora',
      v: rodadas ? rodadas.active : null,
      n: 'em execução ou na fila',
      tone: '',
      fonte: 'rodadas',
    },
    {
      // Era "Travado / precisa de revisão manual". Continua na tela, com o nome
      // do que é: são dois fatos diferentes, e o dono decide coisas diferentes
      // com cada um. Rodada que falhou é problema do agente; o que não fechou
      // aparece na aba Entregas, com o motivo escrito.
      l: 'Rodadas de agente que falharam',
      v: rodadas ? rodadas.failed : null,
      n: rodadas && rodadas.failed ? 'o agente tentou e não terminou' : 'nenhuma rodada falhou',
      tone: 'b',
      fonte: 'rodadas',
    },
  ]
}

/** Um número do cartão de projeto, com o rótulo que o dono lê. */
export interface ContadorDoProjeto {
  rotulo: string
  valor: number
  fonte: FonteDoNumero
}

/**
 * Os contadores do cartão de projeto.
 *
 * `_count.missions` é rodada de agente. Sob o rótulo "Tarefas no total" ele
 * anunciava 3.671 tarefas no gitorch e 1.327 no patinhas — números que não
 * correspondem a nenhum pedido que o dono fez.
 */
export function contadoresDoProjeto(p: { _count?: { missions?: number } }): ContadorDoProjeto[] {
  return [{ rotulo: 'Rodadas de agente', valor: p._count?.missions ?? 0, fonte: 'rodadas' }]
}
