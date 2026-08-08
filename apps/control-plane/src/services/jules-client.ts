// Aciona o dev assíncrono (Jules) de verdade, em vez de pendurar um label e
// esperar que alguém escute.
//
// Medido antes desta mudança, na esteira rodando sobre o próprio repositório do
// produto: o SM delegou corretamente (label numa issue triada como P0),
// passaram-se 13 missões e nenhum PR apareceu — o repositório sequer estava
// conectado na conta do serviço. Um label sem ninguém do outro lado é uma
// campainha muda: some no silêncio e ninguém sabe que a esteira parou ali.
//
// Uma sessão criada pela API tem IDENTIFICADOR. Identificador dá para guardar
// na missão, acompanhar e cobrar — que é o que o watchdog do SM precisa.
//
// Contrato de degradação: nada aqui derruba a delegação. Sem chave, sem
// repositório conectado ou com o serviço fora, devolve `null` com aviso e o
// caminho do label continua valendo como plano B.

const JULES_API = 'https://jules.googleapis.com/v1alpha'
const TIMEOUT_MS = 15_000

/** `dono/repo` → o identificador que a API espera (`sources/github/dono/repo`). */
export function julesSourceName(repository: string): string | null {
  const [owner, repo] = repository.split('/')
  if (!owner || !repo) return null
  return `sources/github/${owner}/${repo}`
}

export interface CriarSessaoDeps {
  /** Chave da API; ausente = recurso desligado (não é erro). */
  apiKey?: string | undefined
  repository: string
  /** Branch de onde o trabalho parte (a base do PR). */
  startingBranch: string
  /** Título da sessão — o mesmo título da task, para dar para casar depois. */
  titulo: string
  /** O pedido em si: a task no padrão da issue. */
  prompt: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}

/**
 * Cria a sessão de trabalho e devolve o identificador dela (`sessions/...`),
 * ou `null` quando não foi possível — sempre com aviso explicando o quê.
 */
export async function criarSessaoJules(deps: CriarSessaoDeps): Promise<string | null> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return null

  const source = julesSourceName(deps.repository)
  if (!source) {
    warn(`[jules] repositório em formato inesperado: '${deps.repository}'`)
    return null
  }

  const f = deps.fetchImpl ?? fetch
  try {
    const resp = await f(`${JULES_API}/sessions`, {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': deps.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: deps.prompt,
        title: deps.titulo,
        sourceContext: {
          source,
          githubRepoContext: { startingBranch: deps.startingBranch },
        },
        // O PR é o entregável que o QA julga: pedir criação automática mantém
        // o ciclo fechado sem depender de ninguém apertar botão.
        automationMode: 'AUTO_CREATE_PR',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!resp.ok) {
      const detalhe = await resp
        .json()
        .then((b: unknown) => JSON.stringify(b).slice(0, 200))
        .catch(() => '')
      // 404 no source é o caso comum e tem conserto conhecido — dizer qual.
      if (resp.status === 404) {
        warn(
          `[jules] o repositório ${deps.repository} não está conectado na conta do dev assíncrono — ` +
            `conecte-o para que a delegação crie sessão de trabalho (HTTP 404: ${detalhe})`
        )
      } else {
        warn(
          `[jules] não foi possível criar a sessão para ${deps.repository} (HTTP ${resp.status}: ${detalhe})`
        )
      }
      return null
    }

    const body = (await resp.json().catch(() => ({}))) as { name?: string }
    if (!body.name) {
      warn(`[jules] sessão criada para ${deps.repository} mas sem identificador na resposta`)
      return null
    }
    return body.name
  } catch (err) {
    warn(`[jules] falha ao acionar o dev assíncrono: ${(err as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Acompanhamento da sessão
//
// Criar sessão sem acompanhar é falar sem ouvir: em produção o dev fez o
// trabalho, terminou com uma pergunta e ficou parado porque ninguém do nosso
// lado escutava. Os três verbos abaixo são o que o loop precisa — ler o
// estado, responder, e aprovar plano.
// ---------------------------------------------------------------------------

export interface SessaoJules {
  estado: string
  ultimaMensagem: string
}

interface AcessoSessao {
  apiKey?: string | undefined
  sessionId: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}

/** `sessions/123` e `123` devem chegar na mesma URL. */
function caminhoDaSessao(sessionId: string): string {
  return sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`
}

/** Estado atual da sessão + a última coisa que o dev disse. */
export async function lerSessaoJules(deps: AcessoSessao): Promise<SessaoJules | null> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return null
  const f = deps.fetchImpl ?? fetch
  const base = `${JULES_API}/${caminhoDaSessao(deps.sessionId)}`
  const headers = { 'X-Goog-Api-Key': deps.apiKey }

  try {
    const resp = await f(base, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!resp.ok) {
      warn(`[jules] não foi possível ler a sessão ${deps.sessionId} (HTTP ${resp.status})`)
      return null
    }
    const sessao = (await resp.json()) as { state?: string }

    // A mensagem vive nas atividades, não no recurso da sessão.
    let ultimaMensagem = ''
    const atividades = await f(`${base}/activities?pageSize=30`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (atividades.ok) {
      const corpo = (await atividades.json()) as {
        activities?: Array<{ agentMessaged?: { agentMessage?: string } }>
      }
      const mensagens = (corpo.activities ?? [])
        .map((a) => a.agentMessaged?.agentMessage)
        .filter((m): m is string => Boolean(m))
      ultimaMensagem = mensagens.at(-1) ?? ''
    }

    return { estado: sessao.state ?? 'DESCONHECIDO', ultimaMensagem }
  } catch (err) {
    warn(`[jules] falha ao ler a sessão ${deps.sessionId}: ${(err as Error).message}`)
    return null
  }
}

/** Responde ao dev assíncrono. O texto vem do motor; quem envia é o executor. */
export async function responderSessaoJules(
  deps: AcessoSessao & { texto: string }
): Promise<boolean> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return false
  const f = deps.fetchImpl ?? fetch

  try {
    const resp = await f(`${JULES_API}/${caminhoDaSessao(deps.sessionId)}:sendMessage`, {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': deps.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: deps.texto }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) {
      warn(`[jules] não foi possível responder a sessão ${deps.sessionId} (HTTP ${resp.status})`)
      return false
    }
    return true
  } catch (err) {
    warn(`[jules] falha ao responder a sessão ${deps.sessionId}: ${(err as Error).message}`)
    return false
  }
}

/** Libera o plano proposto pelo dev — o contrato do trabalho já está na issue. */
export async function aprovarPlanoJules(deps: AcessoSessao): Promise<boolean> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return false
  const f = deps.fetchImpl ?? fetch

  try {
    const resp = await f(`${JULES_API}/${caminhoDaSessao(deps.sessionId)}:approvePlan`, {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': deps.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) {
      warn(
        `[jules] não foi possível aprovar o plano da sessão ${deps.sessionId} (HTTP ${resp.status})`
      )
      return false
    }
    return true
  } catch (err) {
    warn(`[jules] falha ao aprovar o plano da sessão ${deps.sessionId}: ${(err as Error).message}`)
    return false
  }
}
