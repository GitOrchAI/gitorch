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
 * `action_required` pede gente; `stale` é veredito de um código que já não é
 * este. `cancelled` fica de fora TAMBÉM — nunca conta como sucesso —, mas
 * ganhou tratamento PRÓPRIO logo abaixo (`CONCLUSAO_CANCELADA`): sozinho, ele
 * não prova falha nenhuma.
 */
const CONCLUSOES_QUE_NAO_REPROVAM = new Set(['success', 'neutral', 'skipped'])

/**
 * A conclusão "execução interrompida" — nem sucesso, nem prova de falha.
 *
 * L4-T17 (05/09/2026): medido em loureng/patinhas-3d-crafts — 8 PRs abertos,
 * 5 com vários checks cancelados e NENHUM parecer do QA, parando em
 * silêncio. Até aqui `cancelled` caía no mesmo balaio de `failure` (jogava o
 * estado para `red`), e isso só é honesto quando existe falha real por
 * trás. Provado no run 33943490885 (PR #3945): um job de qualidade cujo
 * próprio passo de Prettier falhava rodava `gh run cancel` nele mesmo — o
 * run inteiro cancela em cadeia, e ali existe causa REAL. Mas cancelamento
 * por push novo ou por concorrência (`concurrency: cancel-in-progress`) não
 * tem falha nenhuma atrás: é só um run que ficou para trás. As duas
 * situações são indistinguíveis SÓ com a conclusão do job — quem distingue
 * de verdade (acha o passo que falhou) é `causa-do-cancelamento.ts`, que
 * investiga mais fundo (API de jobs/steps) exatamente quando este módulo
 * devolve `'red'` com cancelamento no meio.
 */
const CONCLUSAO_CANCELADA = 'cancelled'

export type EstadoDoCi = 'no checks' | 'pending' | 'green' | 'red' | 'cancelado'

/**
 * O estado do CI a partir dos check-runs do head.
 *
 * `no checks` é ESTÁVEL, não transitório: um repositório sem verificação não
 * passa a ter uma só porque se espera. `cancelado` é o estado NOVO (L4-T17):
 * todo job que não passou está `cancelled`, e nenhum mostra uma conclusão de
 * falha real — não é reprovação, é "ainda não sei" (a mesma régua de
 * `pending`/`unknown`, só que aqui os checks JÁ terminaram, cancelados).
 * Quem decide o que fazer com cada estado é `decidirSobreVerificacao`.
 */
export function estadoDoCi(runs: CheckDoGithub[]): EstadoDoCi {
  if (runs.length === 0) return 'no checks'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  const naoAprovam = runs.filter((r) => !CONCLUSOES_QUE_NAO_REPROVAM.has(r.conclusion ?? ''))
  if (naoAprovam.length === 0) return 'green'
  const existeFalhaReal = naoAprovam.some((r) => (r.conclusion ?? '') !== CONCLUSAO_CANCELADA)
  return existeFalhaReal ? 'red' : 'cancelado'
}

/**
 * Verde E terminado. É o que o rejulgamento pergunta: só reabre um veredito
 * quando tem certeza de que o motivo caiu.
 */
export function ciTerminouVerde(runs: CheckDoGithub[]): boolean {
  return runs.length > 0 && estadoDoCi(runs) === 'green'
}
