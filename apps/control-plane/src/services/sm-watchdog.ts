import { GithubExecutionError } from './github-backlog.js'

// Watchdog do SM (F3.6): o SM é o dono da esteira — quando o dev assíncrono
// (Jules) falha, é o SM que destrava. Tudo determinístico (a Lei: julgamento
// mecânico é código, não LLM). O estado vive no próprio GitHub: comentários de
// falha do Jules disparam o retry oficial (remover e re-aplicar a label) e
// markers nossos nos comentários contam as tentativas. Estourou o limite →
// `gitorch:stuck` + aviso humano (Telegram, se configurado).

const TASK_LABEL = 'gitorch:task'
const RETRY_MARKER = '<!-- gitorch:sm-retry -->'
const STUCK_MARKER = '<!-- gitorch:sm-stuck -->'
const STUCK_LABEL = 'gitorch:stuck'

// Modos de falha do Jules observados em produção (mensagens dele, verbatim).
const FAILURE_PATTERNS = [
  /Jules has failed to create a task/i,
  /I apologize, but I encountered an unexpected error/i,
]

export interface SmWatchdogOptions {
  repository: string
  githubToken: string
  /** Label de delegação (padrão 'jules'). */
  delegateLabel?: string
  /** Máximo de retentativas por issue antes de escalar (padrão 3). */
  maxRetries?: number
  /** Aviso humano ao escalar (ex.: Telegram). Nunca deve derrubar o watchdog. */
  notify?: (message: string) => Promise<void>
  fetchImpl?: typeof fetch
}

export interface SmWatchdogResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  retried: number[]
  stuck: number[]
}

interface IssueComment {
  body?: string
  created_at?: string
}

export async function runSmWatchdog(options: SmWatchdogOptions): Promise<SmWatchdogResult> {
  const f = options.fetchImpl ?? fetch
  const label = options.delegateLabel ?? 'jules'
  const maxRetries = options.maxRetries ?? 3

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
    // Remover uma label que já não existe não é falha da esteira.
    if (resp.status === 404 && method === 'DELETE') return {}
    if (!resp.ok) throw new GithubExecutionError(`GitHub ${method} ${path} failed (${resp.status})`)
    return resp.json().catch(() => ({}))
  }

  // Tasks atualmente delegadas (task + label do dev) são as vigiadas.
  const issues = (await gh(
    'GET',
    `/repos/${options.repository}/issues?state=open&labels=${encodeURIComponent(
      `${TASK_LABEL},${label}`
    )}&per_page=100`
  )) as Array<{ number: number; labels: Array<{ name: string }> }>

  const retried: number[] = []
  const stuck: number[] = []

  for (const issue of Array.isArray(issues) ? issues : []) {
    const comments = (await gh(
      'GET',
      `/repos/${options.repository}/issues/${issue.number}/comments?per_page=100`
    )) as IssueComment[]
    const list = Array.isArray(comments) ? comments : []

    // Só reage a falha NOVA: posterior à última retentativa que já fizemos —
    // senão o mesmo comentário antigo de erro dispararia retry para sempre.
    const retryStamps = list
      .filter((c) => (c.body ?? '').includes(RETRY_MARKER))
      .map((c) => c.created_at ?? '')
    const retryCount = retryStamps.length
    const lastRetryAt = retryStamps.length > 0 ? retryStamps.sort().at(-1)! : ''
    const failure = list.find(
      (c) =>
        FAILURE_PATTERNS.some((p) => p.test(c.body ?? '')) && (c.created_at ?? '') > lastRetryAt
    )
    if (!failure) continue

    // Se um PR aberto já referencia a issue, o dev está trabalhando — a falha
    // é passado; interferir agora atrapalharia.
    const timeline = (await gh(
      'GET',
      `/repos/${options.repository}/issues/${issue.number}/timeline?per_page=100`
    )) as Array<{
      event?: string
      source?: { issue?: { state?: string; pull_request?: unknown } }
    }>
    const hasOpenPr = (Array.isArray(timeline) ? timeline : []).some(
      (e) =>
        e.event === 'cross-referenced' &&
        e.source?.issue?.pull_request !== undefined &&
        e.source.issue.state === 'open'
    )
    if (hasOpenPr) continue

    if (retryCount >= maxRetries) {
      // Escala uma única vez (idempotente pela label).
      if (issue.labels.some((l) => l.name === STUCK_LABEL)) continue
      await gh('POST', `/repos/${options.repository}/issues/${issue.number}/labels`, {
        labels: [STUCK_LABEL],
      })
      await gh('POST', `/repos/${options.repository}/issues/${issue.number}/comments`, {
        body: `${STUCK_MARKER}\nGitOrch SM: o dev assíncrono falhou ${retryCount}x nesta task. Escalando para revisão humana.`,
      })
      stuck.push(issue.number)
      if (options.notify) {
        await options
          .notify(
            `GitOrch SM: task #${issue.number} de ${options.repository} travada após ${retryCount} retentativas (label ${STUCK_LABEL} aplicada).`
          )
          .catch(() => undefined)
      }
      continue
    }

    // Retry oficial do Jules: remover e re-aplicar a label de delegação.
    await gh(
      'DELETE',
      `/repos/${options.repository}/issues/${issue.number}/labels/${encodeURIComponent(label)}`
    )
    await gh('POST', `/repos/${options.repository}/issues/${issue.number}/labels`, {
      labels: [label],
    })
    await gh('POST', `/repos/${options.repository}/issues/${issue.number}/comments`, {
      body: `${RETRY_MARKER}\nGitOrch SM: falha do dev assíncrono detectada — retentativa ${retryCount + 1}/${maxRetries} (label re-aplicada).`,
    })
    retried.push(issue.number)
  }

  const parts: string[] = []
  if (retried.length > 0) parts.push(`retried ${retried.map((n) => `#${n}`).join(', ')}`)
  if (stuck.length > 0) parts.push(`escalated ${stuck.map((n) => `#${n}`).join(', ')}`)
  return {
    exitCode: 0,
    output: parts.length > 0 ? `SM watchdog: ${parts.join('; ')}.` : 'SM watchdog: all quiet.',
    stderr: '',
    noOp: parts.length === 0,
    retried,
    stuck,
  }
}

/**
 * Notificador Telegram. O `chatId` NÃO sai do env: quem o resolve é
 * `resolveNotifyChatId` (services/telegram-link.ts), a partir do vínculo real do
 * DONO daquele projeto — o bot só alcança quem apertou Start nele. Sem chat
 * resolvido → undefined → o watchdog simplesmente não notifica (nunca despeja o
 * evento de um cliente num chat que não é o dele).
 */
export function buildTelegramNotifier(env: {
  botToken?: string | undefined
  chatId?: string | undefined
  fetchImpl?: typeof fetch
}): ((message: string) => Promise<void>) | undefined {
  const { botToken, chatId } = env
  if (!botToken || !chatId) return undefined
  const f = env.fetchImpl ?? fetch
  return async (message: string) => {
    await f(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    }).catch(() => undefined)
  }
}
