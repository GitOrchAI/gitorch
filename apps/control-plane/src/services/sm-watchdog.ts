import { GithubExecutionError } from './github-backlog.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { fetchComTeto } from './fetch-com-teto.js'

// Watchdog do SM (F3.6): o SM é o dono da esteira — quando o dev assíncrono
// (Jules) falha, é o SM que destrava. Tudo determinístico (a Lei: julgamento
// mecânico é código, não LLM).
//
// Já teve um retry oficial aqui (remover e re-aplicar a label de delegação).
// Aposentado: era inerte desde sempre — a fila de delegação escolhia
// justamente as issues SEM a label, então reaplicá-la numa issue que já a
// tinha nunca a devolvia à fila. A cobrança real mudou para a linha da
// sessão em `dev_sessions` (ver `fila-de-delegacao.ts`): sessão fechada sem
// merge devolve a issue para a fila sozinha, no ciclo seguinte.
//
// O que sobra aqui é só a escalação: os markers `RETRY_MARKER` já gravados
// no histórico de comentários (de antes desta aposentadoria) ainda contam as
// tentativas para o teto — estourou o limite → `gitorch:stuck` + aviso
// humano (Telegram, se configurado).

const TASK_LABEL = 'gitorch:task'
// Não é mais escrito por este arquivo (o retry que o gravava foi aposentado) —
// só lido, para contar tentativas já registradas antes da aposentadoria.
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
  notify?: (message: string) => Promise<boolean>
  fetchImpl?: typeof fetch
}

export interface SmWatchdogResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  stuck: number[]
}

interface IssueComment {
  body?: string
  created_at?: string
}

export async function runSmWatchdog(options: SmWatchdogOptions): Promise<SmWatchdogResult> {
  // IMPORTANTE (leva D): mesma classe de defeito do Crítico —
  // `fetchComTeto` fecha o teto que faltava nesta closure `gh`, alcançável
  // pelo tique sob `tickEmAndamento` (scheduler.ts, wake do SM).
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = fetchComTeto(options.fetchImpl ?? fetchSemPermissao())
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

    // O retentar NÃO mora mais aqui. Reaplicar a etiqueta era inerte: a fila de
    // delegação escolhia justamente as issues SEM a etiqueta, então a issue
    // reaplicada nunca voltava a ser escolhida. A cobrança agora é a linha da
    // sessão (`fila-de-delegacao.ts`): sessão fechada sem merge devolve a issue
    // para a fila no ciclo seguinte, sozinha.
  }

  const parts: string[] = []
  if (stuck.length > 0) parts.push(`escalated ${stuck.map((n) => `#${n}`).join(', ')}`)
  return {
    exitCode: 0,
    output: parts.length > 0 ? `SM watchdog: ${parts.join('; ')}.` : 'SM watchdog: all quiet.',
    stderr: '',
    noOp: parts.length === 0,
    stuck,
  }
}

/**
 * Notificador Telegram. O `chatId` NÃO sai do env: quem o resolve é
 * `resolveNotifyChatId` (services/telegram-link.ts), a partir do vínculo real do
 * DONO daquele projeto — o bot só alcança quem apertou Start nele. Sem chat
 * resolvido → undefined → o watchdog simplesmente não notifica (nunca despeja o
 * evento de um cliente num chat que não é o dele).
 *
 * CRÍTICO (leva D): o `fetch` daqui não carregava teto NENHUM — nem
 * `signal`, nem timeout de nenhum tipo. `avisarDonoDoProjeto` (scheduler.ts)
 * e o watchdog do SM (`runSmWatchdog`, acima) esperam (`await`) o resultado
 * desta função DENTRO da varredura pós-merge (`varrerPublicacoes`), sob a
 * MESMA trava `tickEmAndamento` que o Crítico 1 da leva C já fechou para
 * `ghGet`/`ghSend`/`createCardMover`. Um socket do Telegram que trava (não
 * um erro HTTP — esse já cai no `.catch(() => undefined)` de quem chama)
 * nunca rejeita sozinho: prende `tickEmAndamento` para SEMPRE, e com ela
 * TODA varredura futura, de TODO projeto — provado ao vivo numa cópia: uma
 * chamada ao Telegram que nunca resolve produziu exatamente UMA varredura
 * em toda a execução e mais de trinta tiques consecutivos pulados, sem log
 * nenhum explicando por quê. `fetchComTeto` fecha isso com o mesmo padrão
 * já usado em `ghGet`/`ghSend`. `timeoutMs` é injetável só para teste — em
 * produção nenhum chamador o passa, e o padrão (`TIMEOUT_PADRAO_DE_CHAMADA_MS`,
 * 10s) vale.
 *
 * A função devolvida NUNCA rejeita (todo chamador deste arquivo depende
 * disso — "Nunca deve derrubar o watchdog"): um `.catch(...)` em volta de
 * `notify(...)`, em qualquer chamador, NUNCA dispara (achado Baixo 6 da
 * revisão da Task 5/F8). Por isso o RESULTADO da entrega vem pelo VALOR
 * resolvido — `true` entregue, `false` falhou (bot inválido, destino
 * apagado, timeout) — nunca por rejeição. Fix (branch
 * fix/telegram-notifier-propaga-falha): antes o retorno era `Promise<void>`
 * e uma falha real de entrega ficava muda por padrão sem
 * `onDeliveryFailure`, incluindo para quem tentava ler o resultado via
 * `.then/.catch` (nunca disparava — era o bug real por trás do "avisado"
 * do QA ficar sempre `true` mesmo com o Telegram fora do ar).
 * `onDeliveryFailure` continua existindo à parte, só para quem quer LOGAR a
 * falha sem mudar o fluxo (ex.: um aviso fire-and-forget).
 */
export function buildTelegramNotifier(env: {
  botToken?: string | undefined
  chatId?: string | undefined
  fetchImpl?: typeof fetch
  timeoutMs?: number
  onDeliveryFailure?: (err: unknown) => void
}): ((message: string) => Promise<boolean>) | undefined {
  const { botToken, chatId } = env
  if (!botToken || !chatId) return undefined
  // Os dois lados: o retorno `Promise<boolean>` do #377 (que propaga falha
  // REAL de entrega) e o padrão que falha fechado.
  //
  // Aqui a chamada é para o Telegram, não para o GitHub — a guarda deixaria
  // passar de qualquer jeito. `fetchSemPermissao` fica mesmo assim porque este
  // arquivo TAMBÉM fala com o GitHub em outro ponto, e ter um `?? fetch` cru
  // no meio dele é justamente o que o teste de varredura proíbe: um dia
  // alguém copia a linha de cima para a chamada de baixo.
  const f = fetchComTeto(env.fetchImpl ?? fetchSemPermissao(), env.timeoutMs)
  return async (message: string): Promise<boolean> => {
    return f(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    })
      .then((res) => {
        // Bot token revogado, bot bloqueado pelo destino, chat apagado — a API
        // do Telegram devolve 4xx/5xx, e `fetch` NÃO trata status de erro como
        // rejeição. Sem este check, exatamente os casos que motivaram o
        // Promise<boolean> ("bot inválido, destino apagado") resolveriam
        // `true` do mesmo jeito, porque o `fetch` em si teve sucesso.
        if (!res.ok) {
          env.onDeliveryFailure?.(new Error(`Telegram respondeu ${res.status}`))
          return false
        }
        return true
      })
      .catch((err: unknown) => {
        env.onDeliveryFailure?.(err)
        return false
      })
  }
}
