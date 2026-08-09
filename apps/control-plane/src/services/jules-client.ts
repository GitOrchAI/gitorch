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

/** O que a vigia precisa saber de uma sessão, numa leitura só. */
export interface EstadoDaSessaoLido {
  estado: string
  /** Só o NÚMERO do PR. Ver `numeroDoPrDaSaida` para o porquê. */
  numeroDoPr: number | null
  /** Carimbo da última mudança, usado para detectar sessão que não avança. */
  ultimaAtualizacao: string | null
}

/**
 * Extrai o NÚMERO do PR da saída da sessão.
 *
 * Só o número sai daqui, nunca a URL. A URL vem de serviço externo, e
 * transformá-la em destino de chamada nossa é a mesma classe de falha que já
 * custou caro neste repositório: dado de fora virando alvo de requisição que
 * carrega credencial. Com o número, toda busca é pela rota do próprio
 * repositório, montada por nós.
 *
 * A âncora `/pull/<n>` seguida de fim, barra, `?` ou `#` é deliberada: sem ela,
 * um endereço como `.../pull/63x` ou `.../pull/63.evil` casaria.
 */
export function numeroDoPrDaSaida(outputs: unknown): number | null {
  if (!Array.isArray(outputs)) return null
  for (const saida of outputs) {
    const url = (saida as { pullRequest?: { url?: string } })?.pullRequest?.url
    if (typeof url !== 'string') continue
    const achado = /\/pull\/(\d+)(?:$|[/?#])/.exec(url)?.[1]
    if (achado) {
      const n = Number(achado)
      if (Number.isSafeInteger(n) && n > 0) return n
    }
  }
  return null
}

/**
 * Lê o estado atual de uma sessão.
 *
 * A API não oferece evento nem aviso — só consulta. Toda a vigia se apoia
 * nesta função, e por isso ela nunca lança: falha de rede devolve `null` com
 * aviso, e o ciclo seguinte tenta de novo.
 */
export async function consultarSessaoJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<EstadoDaSessaoLido | null> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return null
  const f = deps.fetchImpl ?? fetch
  try {
    const resp = await f(`${JULES_API}/${deps.sessionName}`, {
      headers: { 'X-Goog-Api-Key': deps.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) {
      warn(`[jules] não foi possível ler a sessão ${deps.sessionName} (HTTP ${resp.status})`)
      return null
    }
    const body = (await resp.json().catch(() => ({}))) as {
      state?: string
      outputs?: unknown
      updateTime?: string
    }
    return {
      estado: body.state ?? 'STATE_UNSPECIFIED',
      numeroDoPr: numeroDoPrDaSaida(body.outputs),
      ultimaAtualizacao: body.updateTime ?? null,
    }
  } catch (err) {
    warn(`[jules] falha ao ler a sessão ${deps.sessionName}: ${(err as Error).message}`)
    return null
  }
}

/** POST em um método da sessão, com o mesmo contrato de degradação do resto. */
async function chamarMetodoDaSessao(deps: {
  apiKey?: string | undefined
  sessionName: string
  metodo: 'sendMessage' | 'approvePlan'
  corpo: Record<string, unknown>
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<boolean> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return false
  const f = deps.fetchImpl ?? fetch
  try {
    const resp = await f(`${JULES_API}/${deps.sessionName}:${deps.metodo}`, {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': deps.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(deps.corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) {
      warn(`[jules] ${deps.metodo} falhou em ${deps.sessionName} (HTTP ${resp.status})`)
      return false
    }
    return true
  } catch (err) {
    warn(`[jules] ${deps.metodo} não chegou em ${deps.sessionName}: ${(err as Error).message}`)
    return false
  }
}

/**
 * Manda uma mensagem para a sessão.
 *
 * É o ÚNICO jeito de destravar uma sessão parada: a API não tem `resume`,
 * `continue` nem `pause` (verificado — respondem 404).
 */
export async function responderSessaoJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  texto: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<boolean> {
  return chamarMetodoDaSessao({ ...deps, metodo: 'sendMessage', corpo: { prompt: deps.texto } })
}

/** Aprova o plano da sessão, sem gastar motor: o contrato já está na issue. */
export async function aprovarPlanoJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<boolean> {
  return chamarMetodoDaSessao({ ...deps, metodo: 'approvePlan', corpo: {} })
}

/**
 * Lê a última mensagem que o dev assíncrono mandou nesta sessão — é o que a
 * vigia usa para decidir uma pergunta pendente e para o hash de idempotência
 * (não responder duas vezes à mesma pergunta).
 *
 * A API não documenta a ordem de retorno de `activities.list`, então não dá
 * para confiar que o último item da página é o mais recente: comparamos
 * `createTime` de cada atividade do ORIGINADOR agente e ficamos com a maior.
 * `pageSize=100` (o teto da API) cobre a folga de uma sessão comum numa
 * página só; sessões com histórico maior que isso são o caso raro que este
 * contrato de degradação aceita (mesma classe de "melhor esforço" do resto
 * deste módulo).
 *
 * Mesmo contrato de degradação do resto do arquivo: nunca lança. Sem chave,
 * sem atividade do agente ou serviço fora do ar devolvem string vazia, com
 * aviso.
 */
export async function ultimaMensagemDoDevJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<string> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return ''
  const f = deps.fetchImpl ?? fetch
  try {
    const resp = await f(`${JULES_API}/${deps.sessionName}/activities?pageSize=100`, {
      headers: { 'X-Goog-Api-Key': deps.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) {
      warn(
        `[jules] não foi possível ler as atividades da sessão ${deps.sessionName} (HTTP ${resp.status})`
      )
      return ''
    }
    const body = (await resp.json().catch(() => ({}))) as {
      activities?: Array<{
        originator?: string
        createTime?: string
        agentMessaged?: { agentMessage?: string }
      }>
    }
    const atividades = Array.isArray(body.activities) ? body.activities : []

    let maisRecente: { texto: string; quando: number } | null = null
    for (const atividade of atividades) {
      if ((atividade.originator ?? '').toLowerCase() !== 'agent') continue
      const texto = atividade.agentMessaged?.agentMessage
      if (typeof texto !== 'string' || texto.length === 0) continue
      const quando = atividade.createTime ? Date.parse(atividade.createTime) : NaN
      if (Number.isNaN(quando)) continue
      if (!maisRecente || quando > maisRecente.quando) {
        maisRecente = { texto, quando }
      }
    }
    return maisRecente?.texto ?? ''
  } catch (err) {
    warn(
      `[jules] falha ao ler as atividades da sessão ${deps.sessionName}: ${(err as Error).message}`
    )
    return ''
  }
}
