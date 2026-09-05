// L4-T17 — medido AO VIVO em loureng/patinhas-3d-crafts (05/09/2026): 8 PRs
// abertos, 5 com vários checks cancelados e NENHUM parecer do QA — param em
// silêncio. Causa provada no run 33943490885 do PR #3945: o workflow do
// cliente tem um job de qualidade (lint, tipagem, formatação) com um passo
// `if: failure()` que roda `gh run cancel` no PRÓPRIO run. O passo que
// falhou foi "Prettier (formatação consistente)" — e o cancelamento em
// cadeia derruba todo o resto.
//
// A armadilha: o job que causou tudo TERMINA marcado `cancelled` no nível do
// PRÓPRIO job (não `failure`) — o pedido de cancelamento do run alcança
// aquele job antes de o GitHub fechar a conclusão dele como falha. A API de
// check-runs (`/commits/{sha}/check-runs`, a que o produto já consulta hoje)
// nunca mostra os passos — só a API de jobs do Actions
// (`GET /repos/{o}/{r}/actions/jobs/{id}`, que usa o MESMO id do check-run)
// devolve `steps[]` com o passo que falhou de verdade.
//
// Este módulo separa a DECISÃO (pura, testável com fixture, sem rede) da
// BUSCA (I/O, testável com um fetcher falso) — mesmo padrão de
// incidente-ci.ts (`coletarAchadosDeInfra` recebe `fetchImpl`).

/** Conclusões de STEP que provam falha real — mesmo conjunto de incidente-ci.ts. */
const CONCLUSOES_DE_FALHA_REAL = new Set(['failure', 'timed_out', 'startup_failure'])

/** Conclusões de JOB que não escondem passo nenhum que interesse investigar. */
const CONCLUSOES_QUE_NAO_PRECISAM_DE_PASSOS = new Set(['success', 'neutral', 'skipped'])

/** Um passo (step) de um job do GitHub Actions. */
export interface PassoDoJob {
  name: string
  conclusion?: string | null | undefined
  /** ISO de quando o passo terminou — usado para achar QUEM falhou primeiro. */
  completedAt?: string | null | undefined
}

/** Um job do GitHub Actions, com os passos JÁ buscados (ou ainda não). */
export interface JobComPassos {
  name: string
  conclusion?: string | null | undefined
  /** `undefined` quando os passos ainda não foram buscados para este job. */
  steps?: readonly PassoDoJob[] | undefined
}

/**
 * Um check-run, reduzido ao que basta para decidir SE vale a pena buscar os
 * passos. `id` é o MESMO id do job na API de Actions — GitHub reusa o
 * espaço de ids entre as duas APIs, então não precisa de outra correlação
 * (nem parsear `details_url`).
 */
export interface JobDoGithub {
  id: number
  name: string
  conclusion?: string | null | undefined
}

export interface CulpadoDoCancelamento {
  job: string
  passo: string
}

/**
 * Acha o job/passo que REALMENTE falhou em meio a jobs cancelados — ou
 * `undefined` quando nenhum passo, em nenhum job, prova falha real
 * (cancelamento SEM culpa: push novo ou concorrência derrubando tudo).
 *
 * Quando mais de um job tem um passo com falha real — o job-gate que só
 * confere "os outros passaram?" (padrão comum em CI com trava cruzada)
 * também acaba falhando, mas como CONSEQUÊNCIA, não como causa —, o
 * critério é QUEM FALHOU PRIMEIRO: ordena pelo instante em que cada passo
 * terminou e devolve o mais antigo. Não precisa reconhecer "isto é um
 * job-gate" pelo nome, só saber que a causa raiz sempre termina ANTES do
 * sintoma.
 */
export function acharCulpadoDoCancelamento(
  jobs: readonly JobComPassos[]
): CulpadoDoCancelamento | undefined {
  const candidatos: Array<{ job: JobComPassos; passo: PassoDoJob }> = []
  for (const job of jobs) {
    for (const passo of job.steps ?? []) {
      if (CONCLUSOES_DE_FALHA_REAL.has(passo.conclusion ?? '')) {
        candidatos.push({ job, passo })
      }
    }
  }
  if (candidatos.length === 0) return undefined
  candidatos.sort((a, b) => (a.passo.completedAt ?? '').localeCompare(b.passo.completedAt ?? ''))
  const primeiro = candidatos[0]!
  return { job: primeiro.job.name, passo: primeiro.passo.name }
}

/**
 * Monta, em português simples e sem jargão de integração contínua, a frase
 * que explica a causa a quem vai consertar. O nome do passo já vem em
 * português do próprio workflow do cliente (quem escreveu o YAML escolheu
 * esse nome) — citar ele direto já basta, sem tentar adivinhar sinônimo.
 */
export function frasarCausaDoCancelamento(culpado: CulpadoDoCancelamento): string {
  return (
    `A verificação automática parou no passo "${culpado.passo}" — dentro de "${culpado.job}" — ` +
    `e o resto foi cancelado por consequência, não por outro defeito.`
  )
}

/**
 * Busca os passos de cada job que NÃO passou (best-effort: um job cuja
 * busca falhar entra como "sem passos", nunca derruba a investigação
 * inteira) e devolve o culpado, se houver.
 *
 * Só busca passos dos jobs candidatos — sucesso/neutro/skipped não escondem
 * passo nenhum que interesse, e pedir os passos deles seria gastar chamada
 * de rede à toa.
 */
export async function investigarCancelamentoEmCadeia(
  jobs: readonly JobDoGithub[],
  buscarPassosDoJob: (jobId: number) => Promise<readonly PassoDoJob[]>
): Promise<CulpadoDoCancelamento | undefined> {
  const candidatos = jobs.filter(
    (j) => !CONCLUSOES_QUE_NAO_PRECISAM_DE_PASSOS.has(j.conclusion ?? '')
  )
  if (candidatos.length === 0) return undefined
  const comPassos = await Promise.all(
    candidatos.map(async (job) => ({
      job,
      steps: await buscarPassosDoJob(job.id).catch(() => [] as readonly PassoDoJob[]),
    }))
  )
  return acharCulpadoDoCancelamento(
    comPassos.map(({ job, steps }) => ({ name: job.name, conclusion: job.conclusion, steps }))
  )
}
