/**
 * O esqueleto do plano fecha quando o trabalho dele acaba.
 *
 * PERGUNTA DO DONO, 27/08: "pq meus repositórios estão com muitas issues mesmo
 * com PR merged?". A maior parte da resposta é esta — e não é trabalho
 * pendente, é estrutura que ficou aberta depois que o trabalho terminou.
 *
 * O PO monta o plano numa árvore de quatro níveis (fase > épico > feature >
 * tarefa) e cada nível vira uma issue, ligada à de cima pelo mecanismo nativo
 * de sub-issue do GitHub. Isso é DESENHO, não defeito: é o que dá ao dono a
 * visão do plano dentro do quadro que ele já usa.
 *
 * O defeito é que só a TAREFA fecha. `fechar-tarefa.ts` fecha o que o produto
 * entregou; fase, épico e feature ficam abertos para sempre. Contado ao vivo
 * no gitorch: 11 fases, 15 épicos e 19 features abertas — 45 issues de pura
 * estrutura contra 20 tarefas de verdade. Cada desejo novo acrescenta mais
 * quatro que nunca mais fecham, e o quadro do cliente vira um depósito onde
 * ele não distingue o que falta fazer do que já acabou.
 *
 * ATENÇÃO ao que este arquivo NÃO faz: ele não fecha nada por conta própria a
 * partir de "parece pronto". Ele exige a prova dura — TODOS os filhos
 * fechados, e pelo menos um filho existindo.
 */

export interface FilhoDaArvore {
  number: number
  aberto: boolean
}

export type DecisaoSobreOPai = { fechar: true; filhos: number } | { fechar: false; motivo: string }

/**
 * Este nível pode fechar?
 *
 * Três guardas, cada uma com um caso real por trás:
 *
 * - Pai já fechado: nada a fazer. Fechar de novo é ruído no histórico do
 *   cliente, e anunciar um fechamento que não aconteceu é uma mentira pequena
 *   — a mesma disciplina de `fechar-tarefa.ts`.
 *
 * - SEM filho nenhum: nunca fecha. Um épico recém-criado, antes de o PO
 *   pendurar as features nele, tem zero filhos — e "zero filhos abertos" é
 *   trivialmente verdadeiro. Sem esta guarda, a varredura fecharia o plano
 *   inteiro no minuto em que ele nascesse, que é o pior estrago possível
 *   aqui: apagar o plano do cliente por causa de uma condição de contorno.
 *
 * - Algum filho aberto: não fecha. É o caso comum e não precisa de defesa.
 */
export function decidirSobreOPai(args: {
  paiAberto: boolean
  filhos: readonly FilhoDaArvore[]
}): DecisaoSobreOPai {
  if (!args.paiAberto) return { fechar: false, motivo: 'já está fechado' }
  if (args.filhos.length === 0) {
    return { fechar: false, motivo: 'ainda não tem nenhum item pendurado nele' }
  }
  const abertos = args.filhos.filter((f) => f.aberto)
  if (abertos.length > 0) {
    return {
      fechar: false,
      motivo: `ainda tem ${abertos.length} item(ns) em aberto: ${abertos
        .slice(0, 5)
        .map((f) => `#${f.number}`)
        .join(', ')}`,
    }
  }
  return { fechar: true, filhos: args.filhos.length }
}

/**
 * O comentário que fica no lugar — a explicação de por que isto fechou.
 *
 * Existe porque um fechamento automático sem motivo é indistinguível de
 * alguém apagando o trabalho do cliente. Ele cita os números para que a
 * pessoa possa conferir em vez de confiar.
 */
export function recadoDeFechamentoDoPai(filhos: readonly FilhoDaArvore[]): string {
  const numeros = filhos.map((f) => `#${f.number}`).join(', ')
  return [
    'Encerrada pelo GitOrch: todo o trabalho pendurado aqui terminou.',
    '',
    `Itens concluídos: ${numeros}.`,
    '',
    'Nada foi descartado — este item existia para agrupar os de cima, e o',
    'agrupamento cumpriu o papel. Se ainda faltar algo, reabra e pendure aqui.',
  ].join('\n')
}

/**
 * A ordem em que os níveis são varridos: de baixo para cima.
 *
 * Importa numa passada só. Fechando a feature primeiro, o épico daquela
 * feature já enxerga o filho fechado e pode fechar na MESMA varredura; na
 * ordem inversa, cada nível levaria uma passada, e uma árvore de quatro
 * níveis demoraria quatro ciclos para se encerrar.
 */
export const NIVEIS_DE_BAIXO_PARA_CIMA = ['feature', 'epic', 'phase'] as const

export type NivelDaArvore = (typeof NIVEIS_DE_BAIXO_PARA_CIMA)[number]

/** O que a varredura precisa saber fazer contra o GitHub. */
export interface PortaDaArvore {
  /** Os itens de estrutura ABERTOS deste nível, do mais antigo ao mais novo. */
  listarPaisAbertos: (nivel: NivelDaArvore) => Promise<Array<{ number: number; nodeId: string }>>
  /** Os filhos pendurados neste item. */
  filhosDe: (nodeId: string) => Promise<FilhoDaArvore[]>
  fechar: (numero: number, recado: string) => Promise<void>
}

export interface ResultadoDaVarredura {
  fechados: number[]
  /** Quantos foram examinados e ficaram abertos, com o porquê do primeiro. */
  mantidos: number
  primeiroMotivo: string | null
}

/**
 * Varre a árvore do plano e fecha o que já cumpriu o papel.
 *
 * De baixo para cima, numa passada só: a feature fecha, e o épico dela já
 * enxerga esse filho fechado ainda nesta varredura.
 *
 * Best-effort item a item: um erro num nó (issue apagada, permissão, rede) não
 * derruba a varredura inteira — o resto do plano do cliente não pode ficar
 * aberto para sempre por causa de um nó problemático.
 */
export async function varrerArvoreDoPlano(args: {
  porta: PortaDaArvore
  log?: { info: (m: string) => void; warn: (m: string) => void }
}): Promise<ResultadoDaVarredura> {
  const fechados: number[] = []
  let mantidos = 0
  let primeiroMotivo: string | null = null

  for (const nivel of NIVEIS_DE_BAIXO_PARA_CIMA) {
    let pais: Array<{ number: number; nodeId: string }>
    try {
      pais = await args.porta.listarPaisAbertos(nivel)
    } catch (err) {
      args.log?.warn(`[árvore] não consegui listar os itens de ${nivel}: ${(err as Error).message}`)
      continue
    }

    for (const pai of pais) {
      try {
        const filhos = await args.porta.filhosDe(pai.nodeId)
        const decisao = decidirSobreOPai({ paiAberto: true, filhos })
        if (!decisao.fechar) {
          mantidos += 1
          primeiroMotivo ??= `#${pai.number} (${nivel}): ${decisao.motivo}`
          continue
        }
        await args.porta.fechar(pai.number, recadoDeFechamentoDoPai(filhos))
        fechados.push(pai.number)
        args.log?.info(
          `[árvore] ${nivel} #${pai.number} encerrado: os ${decisao.filhos} itens dele terminaram`
        )
      } catch (err) {
        args.log?.warn(
          `[árvore] não consegui avaliar ${nivel} #${pai.number}: ${(err as Error).message}`
        )
      }
    }
  }

  return { fechados, mantidos, primeiroMotivo }
}
