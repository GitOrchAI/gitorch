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
 * verde: um repositório de cliente acumulou dez reprovações seguidas por
 * "CI vermelho" com os 16 jobs de verdade passando, e nenhuma entrega mesclou
 * em quatro dias. O próprio GitHub não bloqueia proteção de branch por
 * `skipped` — o produto era mais severo que a plataforma.
 *
 * `neutral` já estava aqui e continua: é o "rodei e não tenho opinião".
 */
const CONCLUSOES_QUE_NAO_REPROVAM = new Set(['success', 'neutral', 'skipped'])

/**
 * As ÚNICAS conclusões que provam falha de um job.
 *
 * O resto que não passou — `cancelled`, `stale`, `action_required`, valor que
 * o GitHub inventar amanhã — não prova defeito de ninguém: o job foi
 * interrompido (push novo, concorrência, fila que estourou), ficou obsoleto
 * ou espera uma pessoa liberar. Reprovar a entrega por isso mandava o dev
 * consertar um código que nunca falhou. Esses casos são `sem-resultado`.
 */
export const CONCLUSOES_DE_FALHA_DO_JOB = new Set(['failure', 'timed_out', 'startup_failure'])

/**
 * A conclusão "execução interrompida". Sozinha não prova falha nenhuma — mas
 * pode ESCONDER uma: um job de qualidade cujo próprio passo de formatação
 * falha e roda `gh run cancel` no run termina `cancelled` no nível do job,
 * nunca `failure`. Quem distingue as duas coisas de verdade (acha o passo que
 * falhou) é `causa-do-cancelamento.ts`, via API de jobs; `investigarEstadoDoCi`
 * a chama sempre que o estado puro é `sem-resultado` com cancelamento no meio.
 */
const CONCLUSAO_CANCELADA = 'cancelled'

/** A única conclusão que prova que um job rodou e passou. */
const CONCLUSAO_DE_SUCESSO = 'success'

export type EstadoDoCi = 'no checks' | 'pending' | 'green' | 'red' | 'sem-resultado'

/**
 * O estado do CI a partir dos check-runs do head.
 *
 * Cinco respostas, e só duas são veredito sobre o código:
 *  - `green`: pelo menos um job rodou e passou, e nada ficou sem resposta;
 *  - `red`: pelo menos um job FALHOU de verdade (`failure`, `timed_out`,
 *    `startup_failure`);
 *  - `pending`: algo ainda roda;
 *  - `sem-resultado`: tudo terminou, ninguém falhou e ainda assim não há
 *    prova de que passou — execuções canceladas, obsoletas, esperando
 *    liberação, ou só jobs pulados. Não é reprovação nem aprovação: o
 *    produto pede uma nova execução (ver `nova-execucao-do-ci.ts`) em vez de
 *    mandar o dev mexer no código;
 *  - `no checks`: nenhum check-run. Aqui só diz que NÃO HÁ check-run; quem
 *    prova que o repositório de fato não tem verificação (ou que tem e esta
 *    não rodou) é `lerEstadoDoCiDoHead`.
 *
 * Um conjunto só de `skipped`/`neutral` é o retrato de logo depois de um push,
 * quando só o job condicional já terminou e os jobs reais ainda não foram
 * registrados (fila do runner): vira `sem-resultado`, e a leitura do commit
 * (`lerEstadoDoCiDoHead`) o promove a `pending` se o workflow ainda roda.
 */
export function estadoDoCi(runs: CheckDoGithub[]): EstadoDoCi {
  if (runs.length === 0) return 'no checks'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  if (runs.some((r) => CONCLUSOES_DE_FALHA_DO_JOB.has(r.conclusion ?? ''))) return 'red'
  const naoAprovam = runs.filter((r) => !CONCLUSOES_QUE_NAO_REPROVAM.has(r.conclusion ?? ''))
  if (naoAprovam.length > 0) return 'sem-resultado'
  return runs.some((r) => r.conclusion === CONCLUSAO_DE_SUCESSO) ? 'green' : 'sem-resultado'
}

/** Os nomes dos jobs que FALHARAM de verdade (nunca os cancelados), sem repetição. */
export function nomesDosJobsComFalha(
  runs: ReadonlyArray<CheckDoGithub & { name?: string | undefined }>
): string[] {
  const nomes = runs
    .filter((r) => CONCLUSOES_DE_FALHA_DO_JOB.has(r.conclusion ?? ''))
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  return [...new Set(nomes)]
}

/** Um check-run com o mínimo extra (`id`+`name`) para dar para investigar os
 *  passos por trás dele — o mesmo `id` que a API de jobs do Actions usa. */
export interface CheckDoGithubInvestigavel extends CheckDoGithub {
  id?: number | undefined
  name?: string | undefined
}

/** Uma execução (workflow run) do commit, reduzida ao que a decisão precisa. */
export interface ExecucaoDoCi {
  id: number
  status: string
  conclusion: string | null
  /** `run_attempt` do GitHub: 1 na primeira vez, 2 depois de uma reexecução. */
  tentativa: number
}

export interface EstadoDoCiInvestigado {
  estado: EstadoDoCi
  culpado: ResultadoDoCulpado
  /** Jobs que falharam de verdade (nunca os cancelados). Vazio fora de `red`. */
  jobsComFalha?: readonly string[]
  /**
   * As execuções do commit, quando a leitura precisou delas; `null` = não deu
   * para ler. Ausente quando o estado já era veredito sem elas.
   */
  execucoes?: readonly ExecucaoDoCi[] | null
}

/**
 * Mesma decisão de `estadoDoCi` — mas quando a resposta PURA seria
 * inconclusiva (`'sem-resultado'` com cancelamento no meio, ou `'red'` com
 * cancelamento misturado a uma falha real noutro job), busca os passos (I/O, via `buscarPassosDoJob`)
 * antes de fechar a resposta.
 *
 * Correção da REGRESSÃO do achado 1 (ver o comentário de `CONCLUSAO_
 * CANCELADA` acima): cancelamento sem falha à vista agora SEMPRE investiga. Se
 * `causa-do-cancelamento.ts` achar um passo que falhou de verdade — único
 * ou ambíguo, não importa: os dois são falha REAL —, o estado é promovido
 * para `'red'` e o culpado vai junto. Só continua `'sem-resultado'` (indefinido)
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
  const jobsComFalha = nomesDosJobsComFalha(runs)
  const temCanceladoNoMeio = runs.some((r) => r.conclusion === CONCLUSAO_CANCELADA)
  const precisaInvestigar =
    temCanceladoNoMeio && (estadoPuro === 'sem-resultado' || estadoPuro === 'red')
  if (!precisaInvestigar) {
    return { estado: estadoPuro, culpado: { encontrado: false }, jobsComFalha }
  }
  const jobs = runs.filter(
    (r): r is CheckDoGithubInvestigavel & { id: number; name: string } =>
      typeof r.id === 'number' && typeof r.name === 'string'
  )
  const culpado = await investigarCancelamentoEmCadeia(jobs, buscarPassosDoJob)
  const estado: EstadoDoCi =
    estadoPuro === 'sem-resultado' && culpado.encontrado ? 'red' : estadoPuro
  return {
    estado,
    culpado,
    // O job do passo que falhou primeiro é a causa; o job-gate que só confere
    // "os outros passaram?" falha como consequência e não deve ser citado.
    jobsComFalha: culpado.encontrado ? nomesDoCulpado(culpado) : jobsComFalha,
  }
}

function nomesDoCulpado(culpado: Extract<ResultadoDoCulpado, { encontrado: true }>): string[] {
  const nomes = culpado.ambiguo ? culpado.candidatos.map((c) => c.job) : [culpado.job]
  return [...new Set(nomes)]
}

/** Um workflow run do Actions, reduzido ao que a decisão precisa. */
export interface WorkflowRunDoGithub {
  id?: number | undefined
  status?: string | undefined
  conclusion?: string | undefined
  tentativa?: number | undefined
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

function algumWorkflowRodando(workflows: readonly WorkflowRunDoGithub[]): boolean {
  return workflows.some((w) => STATUS_DE_WORKFLOW_EM_ANDAMENTO.has(w.status ?? ''))
}

/**
 * Ajusta o estado dos check-runs pelos workflow runs do MESMO commit.
 *
 * Fecha a janela "check-runs ainda não registrados": o workflow run existe
 * (na fila) antes de os jobs dele aparecerem como check-run. Só mexe em
 * `green`, `no checks` e `sem-resultado` — os estados que um job ainda por
 * vir pode desmentir. `null` = não deu para ler: nunca vira verde por isso.
 */
export function ajustarPelosWorkflowsDoHead(
  estado: EstadoDoCi,
  workflows: readonly WorkflowRunDoGithub[] | null
): EstadoDoCi {
  if (estado !== 'green' && estado !== 'no checks' && estado !== 'sem-resultado') return estado
  if (workflows === null) return estado === 'green' ? 'pending' : estado
  return algumWorkflowRodando(workflows) ? 'pending' : estado
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
 * O repositório TEM verificação automática? `true` com pelo menos um arquivo
 * de workflow ativo; `false` só com a lista lida e vazia; `null` quando não
 * deu para ler (e então nada é provado).
 *
 * Os workflows `dynamic/…` são os do próprio GitHub (atualizações do
 * Dependabot, por exemplo): existem em todo repositório que usa o serviço e
 * não verificam código de ninguém.
 */
async function repositorioTemWorkflow(
  repositorio: string,
  ghGet: (caminho: string) => Promise<unknown>
): Promise<boolean | null> {
  try {
    const resposta = await ghGet(`/repos/${repositorio}/actions/workflows?per_page=100`)
    return listaDe(resposta, 'workflows').some(
      (w) => textoDe(w, 'state') === 'active' && !(textoDe(w, 'path') ?? '').startsWith('dynamic/')
    )
  } catch {
    return null
  }
}

/**
 * A ÚNICA leitura do estado do CI de um commit — quem decide julgar, rejulgar
 * ou mesclar passa por aqui, para a régua nunca ter duas cópias.
 *
 * Lê os check-runs (erro de rede sobe para quem chamou), investiga
 * cancelamento quando preciso e, se o resultado não for veredito (`green`,
 * `no checks`, `sem-resultado`), confere os workflow runs do mesmo commit:
 *  - execução ainda rodando: `pending`;
 *  - sem check-run e execução que falhou sem criar job (workflow inválido):
 *    `red`;
 *  - sem check-run e sem execução: `no checks` SÓ quando o repositório não
 *    tem arquivo de workflow ativo. Com workflow e sem execução neste commit
 *    (PR com conflito de merge, push feito por token que não dispara CI), ou
 *    sem conseguir ler a lista, é `sem-resultado` — dizer "o repositório não
 *    tem verificações" seria falso.
 * Estados que já são veredito (`red`, `pending`) não gastam essa segunda
 * leitura. As execuções lidas voltam junto, para quem for pedir nova
 * execução não ler de novo.
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
    .catch((): EstadoDoCiInvestigado => ({
      estado: estadoDoCi(checkRuns),
      culpado: { encontrado: false },
      jobsComFalha: nomesDosJobsComFalha(checkRuns),
    }))

  if (
    investigado.estado !== 'green' &&
    investigado.estado !== 'no checks' &&
    investigado.estado !== 'sem-resultado'
  ) {
    return investigado
  }

  let workflows: WorkflowRunDoGithub[] | null
  try {
    const resposta = await ghGet(
      `/repos/${repositorio}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`
    )
    workflows = listaDe(resposta, 'workflow_runs').map((w) => ({
      id: numeroDe(w, 'id'),
      status: textoDe(w, 'status'),
      conclusion: textoDe(w, 'conclusion'),
      tentativa: numeroDe(w, 'run_attempt'),
    }))
  } catch {
    workflows = null
  }
  const execucoes: ExecucaoDoCi[] | null =
    workflows === null
      ? null
      : workflows.flatMap((w) =>
          typeof w.id === 'number'
            ? [
                {
                  id: w.id,
                  status: w.status ?? '',
                  conclusion: w.conclusion ?? null,
                  tentativa: w.tentativa ?? 1,
                },
              ]
            : []
        )
  const comExecucoes = (estado: EstadoDoCi, extra?: Partial<EstadoDoCiInvestigado>) => ({
    ...investigado,
    ...extra,
    estado,
    execucoes,
  })

  if (investigado.estado !== 'no checks') {
    return comExecucoes(ajustarPelosWorkflowsDoHead(investigado.estado, workflows))
  }

  // Nenhum check-run neste commit.
  if (workflows === null) return comExecucoes('sem-resultado')
  if (algumWorkflowRodando(workflows)) return comExecucoes('pending')
  const falhas = workflows.filter((w) => CONCLUSOES_DE_FALHA_DO_JOB.has(w.conclusion ?? ''))
  if (falhas.length > 0) {
    // Execução que terminou sem criar um job sequer (workflow inválido): é
    // falha do repositório, e o nome dela é o que há para citar.
    return comExecucoes('red', { jobsComFalha: ['workflow do repositório'] })
  }
  if (workflows.length > 0) return comExecucoes('sem-resultado')
  const temWorkflow = await repositorioTemWorkflow(repositorio, ghGet)
  return comExecucoes(temWorkflow === false ? 'no checks' : 'sem-resultado')
}
