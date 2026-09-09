/**
 * O que o conjunto de check-runs do GitHub quer dizer.
 *
 * Existe porque a regra estava escrita DUAS vezes dentro do QA — uma para
 * julgar, outra para decidir se rejulga — e as duas erravam do mesmo jeito.
 */

/** Um check-run, reduzido ao que a decisão precisa. */
export interface CheckDoGithub {
  status?: string | undefined
  conclusion?: string | undefined
}

/**
 * Conclusões que NÃO reprovam.
 *
 * `skipped` é a que faltava, e custou caro. Um job condicional — o que só roda
 * em pull request do Dependabot, o que só age quando há conflito de merge, o
 * que sincroniza diagrama — termina `skipped` em TODA entrega normal. Contando
 * isso como falha, um repositório com três jobs condicionais nunca tem CI
 * verde: o `loureng/patinhas-3d-crafts` acumulou dez reprovações seguidas por
 * "CI vermelho" com os 16 jobs de verdade passando, e nenhuma entrega mesclou
 * em quatro dias. O próprio GitHub não bloqueia proteção de branch por
 * `skipped` — o produto era mais severo que a plataforma.
 *
 * `neutral` já estava aqui e continua: é o "rodei e não tenho opinião".
 *
 * O que fica de fora reprova de propósito: `failure` e `timed_out` são falha;
 * `cancelled` é execução interrompida, e aprovar sobre ela seria aprovar sobre
 * um teste que não terminou; `action_required` pede gente; `stale` é veredito
 * de um código que já não é este.
 */
const CONCLUSOES_QUE_NAO_REPROVAM = new Set(['success', 'neutral', 'skipped'])

export type EstadoDoCi = 'no checks' | 'pending' | 'green' | 'red'

/**
 * O estado do CI a partir dos check-runs do head.
 *
 * `no checks` é ESTÁVEL, não transitório: um repositório sem verificação não
 * passa a ter uma só porque se espera. Quem decide o que fazer com cada estado
 * é `decidirSobreVerificacao`.
 */
export function estadoDoCi(runs: CheckDoGithub[]): EstadoDoCi {
  if (runs.length === 0) return 'no checks'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  return runs.every((r) => CONCLUSOES_QUE_NAO_REPROVAM.has(r.conclusion ?? '')) ? 'green' : 'red'
}

/**
 * Verde E terminado. É o que o rejulgamento pergunta: só reabre um veredito
 * quando tem certeza de que o motivo caiu.
 */
export function ciTerminouVerde(runs: CheckDoGithub[]): boolean {
  return runs.length > 0 && estadoDoCi(runs) === 'green'
}
