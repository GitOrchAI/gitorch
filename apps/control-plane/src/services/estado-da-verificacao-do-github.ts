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

/** A única conclusão que prova que um job rodou e passou. */
const CONCLUSAO_DE_SUCESSO = 'success'

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
 *
 * Verde exige PROVA: pelo menos um check-run `success`. Um conjunto só de
 * `skipped`/`neutral` não mostra que nada rodou e passou — é o retrato de
 * logo depois de um push, quando só o job condicional já terminou e os jobs
 * reais ainda não foram registrados (fila do runner). Por isso vira
 * `pending`, não `no checks`: ainda pode chegar check-run real, e `pending`
 * tem teto próprio na vigília (`avisar-demora`), então nunca fica mudo.
 */
export function estadoDoCi(runs: CheckDoGithub[]): EstadoDoCi {
  if (runs.length === 0) return 'no checks'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  const naoAprovam = runs.filter((r) => !CONCLUSOES_QUE_NAO_REPROVAM.has(r.conclusion ?? ''))
  if (naoAprovam.length === 0) {
    return runs.some((r) => r.conclusion === CONCLUSAO_DE_SUCESSO) ? 'green' : 'pending'
  }
  const existeFalhaReal = naoAprovam.some((r) => (r.conclusion ?? '') !== CONCLUSAO_CANCELADA)
  return existeFalhaReal ? 'red' : 'cancelado'
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

/** Um workflow run do Actions, reduzido ao status. */
export interface WorkflowRunDoGithub {
  status?: string | undefined
}

/**
 * Status de workflow run que ainda não terminou. Um run nesses estados pode
 * ter jobs que ainda nem viraram check-run.
 */
const STATUS_DE_WORKFLOW_EM_ANDAMENTO = new Set([
  'queued',
  'in_progress',
  'waiting',
  'pending',
  'requested',
])

/**
 * Ajusta o estado dos check-runs pelos workflow runs do MESMO commit.
 *
 * Fecha a janela "check-runs ainda não registrados": o workflow run existe
 * (na fila) antes de os jobs dele aparecerem como check-run. Só mexe em
 * `green` e `no checks` — os dois estados que um job ainda por vir pode
 * desmentir. `null` = não deu para ler: nunca vira verde por isso.
 */
export function ajustarPelosWorkflowsDoHead(
  estado: EstadoDoCi,
  workflows: readonly WorkflowRunDoGithub[] | null
): EstadoDoCi {
  if (estado !== 'green' && estado !== 'no checks') return estado
  if (workflows === null) return estado === 'green' ? 'pending' : estado
  const algumRodando = workflows.some((w) => STATUS_DE_WORKFLOW_EM_ANDAMENTO.has(w.status ?? ''))
  return algumRodando ? 'pending' : estado
}

/** Um campo de texto de um objeto vindo da API, sem confiar no formato. */
function textoDe(obj: unknown, campo: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined
  const valor: unknown = Reflect.get(obj, campo)
  return typeof valor === 'string' ? valor : undefined
}

function numeroDe(obj: unknown, campo: string): number | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined
  const valor: unknown = Reflect.get(obj, campo)
  return typeof valor === 'number' ? valor : undefined
}

function listaDe(obj: unknown, campo: string): unknown[] {
  if (typeof obj !== 'object' || obj === null) return []
  const valor: unknown = Reflect.get(obj, campo)
  return Array.isArray(valor) ? valor : []
}

/**
 * A ÚNICA leitura do estado do CI de um commit — quem decide julgar, rejulgar
 * ou mesclar passa por aqui, para a régua nunca ter duas cópias.
 *
 * Lê os check-runs (erro de rede sobe para quem chamou), investiga
 * cancelamento quando preciso e, se o resultado for `green` ou `no checks`,
 * confere os workflow runs do mesmo commit. Estados que já são veredito
 * (`red`, `pending`, `cancelado`) não gastam essa segunda leitura.
 */
export async function lerEstadoDoCiDoHead(args: {
  repositorio: string
  sha: string
  ghGet: (caminho: string) => Promise<unknown>
}): Promise<EstadoDoCiInvestigado> {
  const { repositorio, sha, ghGet } = args
  const respostaDosChecks = await ghGet(
    `/repos/${repositorio}/commits/${sha}/check-runs?per_page=100`
  )
  const checkRuns: CheckDoGithubInvestigavel[] = listaDe(respostaDosChecks, 'check_runs').map(
    (c) => ({
      id: numeroDe(c, 'id'),
      name: textoDe(c, 'name'),
      status: textoDe(c, 'status'),
      conclusion: textoDe(c, 'conclusion'),
    })
  )
  const investigado = await investigarEstadoDoCi(checkRuns, async (jobId) => {
    const job = await ghGet(`/repos/${repositorio}/actions/jobs/${jobId}`)
    return listaDe(job, 'steps').map((p) => ({
      name: textoDe(p, 'name') ?? '',
      conclusion: textoDe(p, 'conclusion') ?? null,
      completedAt: textoDe(p, 'completed_at') ?? null,
    }))
  })
    // Crash inesperado na investigação: recua para a resposta pura, sem
    // inventar culpado.
    .catch(() => ({ estado: estadoDoCi(checkRuns), culpado: { encontrado: false as const } }))

  if (investigado.estado !== 'green' && investigado.estado !== 'no checks') return investigado

  let workflows: WorkflowRunDoGithub[] | null
  try {
    const resposta = await ghGet(
      `/repos/${repositorio}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`
    )
    workflows = listaDe(resposta, 'workflow_runs').map((w) => ({ status: textoDe(w, 'status') }))
  } catch {
    workflows = null
  }
  return {
    estado: ajustarPelosWorkflowsDoHead(investigado.estado, workflows),
    culpado: investigado.culpado,
  }
}
