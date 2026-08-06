import { GithubExecutionError } from './github-backlog.js'

// Delegação contínua do SM (F3.6 item 2): a cada wake, encontra as TASKS prontas
// (label `gitorch:task`, sem `jules`, com todos os "Blocked by" já fechados) e
// aplica a label de delegação — assim uma task que desbloqueia no MEIO da sprint
// segue sozinha, sem esperar o próximo sprint-planning. É determinístico (o
// "julgamento" mecânico é código, não LLM — a Lei).

const TASK_LABEL = 'gitorch:task'

export interface SmDelegationOptions {
  repository: string
  githubToken: string
  /** Label de delegação (padrão 'jules'). */
  delegateLabel?: string
  /** Máximo de delegações por ciclo (fluxo sustentável; padrão 3). */
  cap?: number
  /**
   * Aciona o dev assíncrono de verdade e devolve o identificador da sessão.
   *
   * Sem isto, delegar era só pendurar o label e esperar que alguém do outro
   * lado percebesse — se ninguém estivesse escutando, a esteira morria em
   * silêncio. Devolver `null` é aceitável (recurso desligado, repositório não
   * conectado, serviço fora): o label continua valendo como plano B.
   */
  criarSessaoDev?: (args: {
    repository: string
    titulo: string
    prompt: string
  }) => Promise<string | null>
  fetchImpl?: typeof fetch
}

export interface SmDelegationResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  delegated: number[]
}

/** Extrai os números de "Blocked by #N, #M" do corpo da issue. */
export function extractBlockers(body: string): number[] {
  const line = body.match(/Blocked by\s+([#\d,\s]+)/i)?.[1]
  if (!line) return []
  return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
}

export async function runSmDelegation(options: SmDelegationOptions): Promise<SmDelegationResult> {
  const f = options.fetchImpl ?? fetch
  const label = options.delegateLabel ?? 'jules'
  const cap = options.cap ?? 3

  const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const resp = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!resp.ok) throw new GithubExecutionError(`GitHub ${method} ${path} failed (${resp.status})`)
    return resp.json().catch(() => ({}))
  }

  // Candidatas: tasks abertas do GitOrch ainda NÃO delegadas.
  const tasks = (await gh(
    'GET',
    `/repos/${options.repository}/issues?state=open&labels=${encodeURIComponent(TASK_LABEL)}&per_page=100`
  )) as Array<{ number: number; title?: string; labels: Array<{ name: string }>; body?: string }>
  const candidates = (Array.isArray(tasks) ? tasks : []).filter(
    (t) => !t.labels.some((l) => l.name === label)
  )

  const delegated: number[] = []
  // Identificadores das sessões abertas no dev assíncrono, para o watchdog cobrar.
  const sessoes: string[] = []
  for (const task of candidates) {
    if (delegated.length >= cap) break
    // Pronta = todos os "Blocked by" fechados.
    const blockers = extractBlockers(task.body ?? '')
    let ready = true
    for (const b of blockers) {
      const blocker = (await gh('GET', `/repos/${options.repository}/issues/${b}`)) as {
        state?: string
      }
      if (blocker.state !== 'closed') {
        ready = false
        break
      }
    }
    if (!ready) continue
    await gh('POST', `/repos/${options.repository}/issues/${task.number}/labels`, {
      labels: [label],
    })
    delegated.push(task.number)

    // O label marca a issue; a sessão é quem efetivamente põe o dev a
    // trabalhar. Guardamos o identificador na saída da missão para o watchdog
    // ter o que cobrar depois.
    if (options.criarSessaoDev) {
      const sessao = await options.criarSessaoDev({
        repository: options.repository,
        titulo: `#${task.number} ${task.title ?? ''}`.trim(),
        prompt: [
          `Work on issue #${task.number} of ${options.repository}.`,
          '',
          task.body ?? '',
          '',
          'Deliver a pull request that closes the issue and satisfies every item',
          'under "Verification Criteria". Do not change anything outside the scope',
          'described above.',
        ].join('\n'),
      })
      if (sessao) sessoes.push(`#${task.number}→${sessao}`)
    }
  }

  return {
    exitCode: 0,
    output:
      delegated.length > 0
        ? `SM delegated ${delegated.length} ready task(s): ${delegated.map((n) => `#${n}`).join(', ')}.` +
          (sessoes.length > 0 ? ` Dev sessions: ${sessoes.join(', ')}.` : '')
        : 'SM: no newly-ready task to delegate.',
    stderr: '',
    noOp: delegated.length === 0,
    delegated,
  }
}
