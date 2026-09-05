/**
 * O que o conjunto de check-runs do GitHub quer dizer.
 *
 * Existe porque a regra estava escrita DUAS vezes dentro do QA — uma para
 * julgar, outra para decidir se rejulga — e as duas erravam do mesmo jeito.
 */

import {
  investigarCancelamentoEmCadeia,
  type PassoDoJob,
  type ResultadoDoCulpado,
} from './causa-do-cancelamento.js'

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
 * investiga mais fundo (API de jobs/steps).
 *
 * CORREÇÃO (fix-up L4-T17, achado 1 da revisão — REGRESSÃO): a versão
 * original só chamava essa investigação mais funda quando este módulo já
 * devolvia `'red'` com cancelamento misturado a uma falha real noutro job —
 * nunca quando devolvia `'cancelado'` puro. Resultado medido: um workflow
 * de cliente sem um job SEPARADO que termine `failure` (o caso mais comum —
 * o próprio job que falhou já cancela a si mesmo, ver `causa-do-
 * cancelamento.ts`) fazia o estado ficar `'cancelado'` para sempre, e a
 * vigília (`vigia-da-verificacao.ts`) só sabe esperar diante desse estado —
 * nunca chega a julgar. Antes de L4-T17, `cancelled` virava `'red'` direto:
 * pior explicado, mas ao menos era julgado. `investigarEstadoDoCi`, abaixo,
 * fecha o buraco: investiga TAMBÉM quando a resposta pura é `'cancelado'`,
 * e só continua indefinido quando de fato não há falha em passo nenhum.
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

/** Um check-run com o mínimo extra (`id`+`name`) para dar para investigar os
 *  passos por trás dele — o mesmo `id` que a API de jobs do Actions usa. */
export interface CheckDoGithubInvestigavel extends CheckDoGithub {
  id?: number | undefined
  name?: string | undefined
}

export interface EstadoDoCiInvestigado {
  estado: EstadoDoCi
  culpado: ResultadoDoCulpado
}

/**
 * Mesma decisão de `estadoDoCi` — mas quando a resposta PURA seria
 * inconclusiva (`'cancelado'`, ou `'red'` com cancelamento misturado a uma
 * falha real noutro job), busca os passos (I/O, via `buscarPassosDoJob`)
 * antes de fechar a resposta.
 *
 * Correção da REGRESSÃO do achado 1 (ver o comentário de `CONCLUSAO_
 * CANCELADA` acima): `'cancelado'` agora SEMPRE investiga. Se
 * `causa-do-cancelamento.ts` achar um passo que falhou de verdade — único
 * ou ambíguo, não importa: os dois são falha REAL —, o estado é promovido
 * para `'red'` e o culpado vai junto. Só continua `'cancelado'` (indefinido)
 * quando a investigação não acha falha real em passo nenhum — e esse
 * "continua esperando" já tem teto próprio: `decidirSobreVerificacao`
 * (vigia-da-verificacao.ts) vira `'avisar-demora'` depois de
 * `TETO_DE_ESPERA_MS`, então mesmo o cancelamento genuinamente sem culpa
 * não fica parado indefinidamente — só deixa de ser julgado como veredito.
 *
 * `'red'` que já era `'red'` por si (uma falha real direta, sem
 * cancelamento misturado) nunca precisa investigar — nada escondido para
 * achar, e gastar a chamada seria à toa.
 */
export async function investigarEstadoDoCi(
  // Mutável, não `readonly`: `estadoDoCi` (acima) já pede `CheckDoGithub[]`
  // mutável, e esta função só embrulha aquela — mesmo tipo de entrada.
  runs: CheckDoGithubInvestigavel[],
  buscarPassosDoJob: (jobId: number) => Promise<readonly PassoDoJob[]>
): Promise<EstadoDoCiInvestigado> {
  const estadoPuro = estadoDoCi(runs)
  const temCanceladoNoMeio = runs.some((r) => r.conclusion === CONCLUSAO_CANCELADA)
  const precisaInvestigar =
    estadoPuro === 'cancelado' || (estadoPuro === 'red' && temCanceladoNoMeio)
  if (!precisaInvestigar) {
    return { estado: estadoPuro, culpado: { encontrado: false } }
  }
  const jobs = runs.filter(
    (r): r is CheckDoGithubInvestigavel & { id: number; name: string } =>
      typeof r.id === 'number' && typeof r.name === 'string'
  )
  const culpado = await investigarCancelamentoEmCadeia(jobs, buscarPassosDoJob)
  const estado: EstadoDoCi = estadoPuro === 'cancelado' && culpado.encontrado ? 'red' : estadoPuro
  return { estado, culpado }
}
