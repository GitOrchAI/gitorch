/**
 * Pedir ao GitHub UMA nova execução da verificação de um commit.
 *
 * Existe porque uma execução cancelada (fila que estourou, push novo,
 * concorrência) não diz nada sobre o código, e o produto ficava esperando
 * para sempre um resultado que ninguém ia produzir. Reprovar a entrega seria
 * mandar o dev consertar o que nunca falhou; esperar calado, prender a
 * entrega. A saída é repetir a execução — uma vez.
 *
 * O TETO é por commit e tem duas camadas:
 *  - no GitHub: a segunda tentativa de uma execução tem `run_attempt` 2. Se
 *    qualquer execução do commit já passou da primeira, o pedido já foi feito
 *    (por nós ou por alguém) e não se repete. Sobrevive a reinício do serviço.
 *  - na memória do processo: cada commit é tentado uma vez, com sucesso ou
 *    não. É o que impede um erro de permissão de ser tentado (e registrado) a
 *    cada passada. Um reinício do serviço esquece isso e custa, no pior caso,
 *    uma tentativa a mais por commit.
 *
 * Quem escreve no GitHub é a porta de saída que o chamador entrega
 * (`ghEnviar`), a mesma com a guarda de autonomia: sem licença, o pedido é
 * recusado ali e volta como "sem permissão".
 */

import { CONCLUSOES_DE_FALHA_DO_JOB } from './estado-da-verificacao-do-github.js'
import type { ExecucaoDoCi } from './estado-da-verificacao-do-github.js'

export type MotivoDaNovaExecucao = 'sem-resultado' | 'falha-de-infraestrutura'

export type DecisaoDeNovaExecucao =
  | {
      acao: 'pedir'
      execucoes: Array<{ id: number; rota: 'rerun' | 'rerun-failed-jobs' }>
    }
  | { acao: 'nada'; motivo: 'sem-execucao' | 'ja-reexecutada' | 'nada-reexecutavel' }

/**
 * O que pedir, dadas as execuções do commit. Pura.
 *
 *  - `sem-resultado`: repete as execuções CANCELADAS, inteiras (`rerun`);
 *  - `falha-de-infraestrutura`: repete só os jobs que falharam
 *    (`rerun-failed-jobs`), nas execuções que terminaram em falha.
 * Execução obsoleta (`stale`) ou esperando liberação (`action_required`) não
 * se repete: o pedido não resolve, quem resolve é uma pessoa.
 */
export function decidirNovaExecucao(
  execucoes: readonly ExecucaoDoCi[],
  motivo: MotivoDaNovaExecucao
): DecisaoDeNovaExecucao {
  if (execucoes.length === 0) return { acao: 'nada', motivo: 'sem-execucao' }
  if (execucoes.some((e) => e.tentativa > 1)) return { acao: 'nada', motivo: 'ja-reexecutada' }
  const alvos =
    motivo === 'sem-resultado'
      ? execucoes
          .filter((e) => e.conclusion === 'cancelled')
          .map((e) => ({ id: e.id, rota: 'rerun' as const }))
      : execucoes
          .filter((e) => CONCLUSOES_DE_FALHA_DO_JOB.has(e.conclusion ?? ''))
          .map((e) => ({ id: e.id, rota: 'rerun-failed-jobs' as const }))
  return alvos.length === 0
    ? { acao: 'nada', motivo: 'nada-reexecutavel' }
    : { acao: 'pedir', execucoes: alvos }
}

export interface ResultadoDaNovaExecucao {
  /** O pedido foi feito ao GitHub nesta chamada. */
  pedida: boolean
  /** Esta é a primeira vez que o commit é tratado: só então vale registrar/avisar. */
  primeiraVez: boolean
  /** Em português simples, pronto para a saída da missão e o painel. */
  texto: string
}

/** Quantos commits lembrar. Passou disto, esquece os mais antigos. */
const TETO_DE_COMMITS_LEMBRADOS = 5000
const jaTratados = new Set<string>()

/** Só os testes: esquece o que o processo já tentou. */
export function esquecerPedidosDeNovaExecucao(): void {
  jaTratados.clear()
}

function semPermissao(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'EscritaNaoAutorizadaError' || /\((401|403|404)\)/.test(err.message)
}

export async function pedirNovaExecucaoDoCi(args: {
  repositorio: string
  sha: string
  motivo: MotivoDaNovaExecucao
  /** As execuções que a leitura do CI já trouxe; sem elas, lê aqui. */
  execucoes?: readonly ExecucaoDoCi[] | null | undefined
  ghGet: (caminho: string) => Promise<unknown>
  ghEnviar: (metodo: 'POST', caminho: string) => Promise<unknown>
}): Promise<ResultadoDaNovaExecucao> {
  const { repositorio, sha, motivo } = args
  const chave = `${repositorio}@${sha}`
  if (jaTratados.has(chave)) {
    return {
      pedida: false,
      primeiraVez: false,
      texto: 'já tratei a verificação deste commit uma vez; não peço de novo',
    }
  }

  let execucoes = args.execucoes
  if (execucoes == null) {
    try {
      const resposta = await args.ghGet(
        `/repos/${repositorio}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`
      )
      execucoes = lerExecucoes(resposta)
    } catch {
      // Sem ler não dá para decidir; nada é marcado, a próxima passada tenta.
      return {
        pedida: false,
        primeiraVez: false,
        texto: 'não consegui ler as execuções deste commit para pedir uma nova',
      }
    }
  }

  const decisao = decidirNovaExecucao(execucoes, motivo)
  if (decisao.acao === 'nada') {
    const texto =
      decisao.motivo === 'sem-execucao'
        ? 'a verificação não gerou nenhuma execução neste commit; não há o que repetir'
        : decisao.motivo === 'ja-reexecutada'
          ? 'a verificação deste commit já foi repetida uma vez; não peço de novo'
          : 'a execução deste commit não é do tipo que se repete sozinho'
    // `ja-reexecutada` é definitivo para o commit; os outros dependem de
    // execuções que ainda podem aparecer.
    if (decisao.motivo === 'ja-reexecutada') lembrar(chave)
    return { pedida: false, primeiraVez: false, texto }
  }

  lembrar(chave)
  try {
    for (const alvo of decisao.execucoes) {
      await args.ghEnviar('POST', `/repos/${repositorio}/actions/runs/${alvo.id}/${alvo.rota}`)
    }
  } catch (err) {
    return {
      pedida: false,
      primeiraVez: true,
      texto: semPermissao(err)
        ? 'não tenho permissão para pedir ao GitHub uma nova execução da verificação; ' +
          'peça a repetição no próprio GitHub ou envie um commit novo'
        : `não consegui pedir ao GitHub uma nova execução da verificação (${
            err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
          })`,
    }
  }
  return {
    pedida: true,
    primeiraVez: true,
    texto:
      motivo === 'sem-resultado'
        ? 'a verificação deste commit foi cancelada; pedi ao GitHub uma nova execução'
        : 'a verificação deste commit falhou ao preparar o ambiente; pedi ao GitHub uma nova execução',
  }
}

function lembrar(chave: string): void {
  if (jaTratados.size >= TETO_DE_COMMITS_LEMBRADOS) {
    const maisAntigo = jaTratados.values().next().value
    if (maisAntigo !== undefined) jaTratados.delete(maisAntigo)
  }
  jaTratados.add(chave)
}

function lerExecucoes(resposta: unknown): ExecucaoDoCi[] {
  const lista: unknown =
    typeof resposta === 'object' && resposta !== null
      ? Reflect.get(resposta, 'workflow_runs')
      : undefined
  if (!Array.isArray(lista)) return []
  return lista.flatMap((w: unknown) => {
    const id: unknown = typeof w === 'object' && w !== null ? Reflect.get(w, 'id') : undefined
    if (typeof id !== 'number') return []
    const campo = (nome: string): unknown => Reflect.get(w as object, nome)
    const status = campo('status')
    const conclusao = campo('conclusion')
    const tentativa = campo('run_attempt')
    return [
      {
        id,
        status: typeof status === 'string' ? status : '',
        conclusion: typeof conclusao === 'string' ? conclusao : null,
        tentativa: typeof tentativa === 'number' ? tentativa : 1,
      },
    ]
  })
}
