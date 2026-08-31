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

import type { ResultadoDoAcionamentoDoDev } from './sm-delegation.js'

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
  /**
   * Para onde a sessão DEVOLVE o trabalho, quando o destino não pode ser um
   * ramo novo qualquer.
   *
   * É o que faz um conserto cair na entrega que JÁ EXISTE: com
   * `automationMode: 'AUTO_CREATE_PR'` e sem isto, o Jules inventa um ramo e
   * abre um pull request NOVO — inútil para retomar um pull request órfão, e
   * pior que não fazer nada, porque passa a haver dois.
   *
   * Contrato conferido AO VIVO em 31/08/2026 contra `jules.googleapis.com`,
   * sem criar sessão nenhuma (fonte inexistente de propósito):
   *   · campo inventado no `sourceContext` → HTTP 400 `Cannot find field`
   *   · `sourceContext.workingBranch`      → passou a validação (HTTP 404 na fonte)
   *   · `automationMode` inventado         → HTTP 400 `Invalid value`
   * E o documento de descoberta (`v1alpha`, revisão 20260830) descreve o campo
   * como "the branch to push to for the session", usado justamente quando a
   * automação criaria um ramo.
   */
  workingBranch?: string | undefined
  /** Título da sessão — o mesmo título da task, para dar para casar depois. */
  titulo: string
  /** O pedido em si: a task no padrão da issue. */
  prompt: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}

/**
 * Cria a sessão de trabalho e diz, com todas as letras, o que aconteceu.
 *
 * Devolvia `string | null` até 22/08/2026, e esse `null` juntava duas coisas
 * que precisam ficar separadas: "não configurado" e "o dev recusou". Quem
 * chamava não conseguia distinguir e seguia como se tivesse delegado nos dois
 * casos — foi assim que onze issues ficaram marcadas como em andamento sem
 * nunca ter começado. Agora o motivo real volta junto.
 */
export async function criarSessaoJules(
  deps: CriarSessaoDeps
): Promise<ResultadoDoAcionamentoDoDev> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return { situacao: 'desligado' }

  const source = julesSourceName(deps.repository)
  if (!source) {
    const motivo = `repositório em formato inesperado: '${deps.repository}'`
    warn(`[jules] ${motivo}`)
    return { situacao: 'falhou', motivo }
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
          // Ausente quando ninguém pediu: aí o Jules escolhe o ramo, que é o
          // certo para trabalho novo. `undefined` some do JSON.
          ...(deps.workingBranch ? { workingBranch: deps.workingBranch } : {}),
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
      const motivo =
        resp.status === 404
          ? `o repositório ${deps.repository} não está conectado na conta do dev assíncrono — ` +
            `conecte-o para que a delegação crie sessão de trabalho (HTTP 404: ${detalhe})`
          : `HTTP ${resp.status}: ${detalhe}`
      warn(`[jules] ${motivo}`)
      return { situacao: 'falhou', motivo }
    }

    const body = (await resp.json().catch(() => ({}))) as { name?: string }
    if (!body.name) {
      const motivo = `sessão criada para ${deps.repository} mas sem identificador na resposta`
      warn(`[jules] ${motivo}`)
      return { situacao: 'falhou', motivo }
    }
    return { situacao: 'criada', sessionName: body.name }
  } catch (err) {
    const motivo = (err as Error).message
    warn(`[jules] falha ao acionar o dev assíncrono: ${motivo}`)
    return { situacao: 'falhou', motivo }
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

/**
 * Uma sessão como o fornecedor a descreve na listagem.
 *
 * Deliberadamente magro: só o que a reconciliação de vagas precisa decidir.
 */
export interface SessaoListada {
  sessionName: string
  archived: boolean
  criadaEm: string | null
}

/**
 * Teto de páginas da listagem.
 *
 * Eram vinte, e a primeira varredura em produção (22/08/2026, 23:02) BATEU
 * nele: "listagem de sessões parou no teto de 20 páginas; seguindo com as 2000
 * já lidas". Truncar aqui deixa a reconciliação cega para tudo o que está além
 * — ela não erra, ela simplesmente nunca fica sabendo.
 *
 * CORREÇÃO (23/08/2026): a versão anterior deste comentário afirmava que
 * arquivar NÃO remove a sessão da listagem e que por isso o número só cresce.
 * Está errado, e a medição em produção é direta — a listagem encolhe
 * exatamente pelo tanto que se arquiva, dez por rodada: 1982, depois 1972,
 * depois 1962. O fornecedor para de devolver a sessão arquivada.
 *
 * O número cem, porém, continua justificado, e por um motivo melhor: a leitura
 * ficou PRESA em exatamente 2000 por várias rodadas seguidas antes de começar
 * a cair. Ficar presa no teto é a assinatura de que o total real era MAIOR que
 * ele — só não dava para saber quanto maior. Cem páginas cobrem dez mil
 * sessões e tiram essa cegueira.
 *
 * O teto continua existindo — um cursor defeituoso não pode prender a vigília
 * num laço —, e o aviso ao batê-lo continua saindo, para que este mesmo número
 * volte a ser revisto com medição, e não com palpite.
 */
const MAX_PAGINAS_DA_LISTAGEM = 100

/**
 * Lista as sessões que existem no fornecedor, paginando até o fim.
 *
 * Existe para a varredura de reconciliação poder responder "o que está aberto
 * lá fora que ninguém aqui reconhece". Sem esta pergunta, as vagas que já
 * vazaram ficam presas para sempre: o produto só sabe fechar aquilo que ele
 * mesmo tem registrado.
 *
 * DUAS DECISÕES QUE PARECEM DETALHE E NÃO SÃO:
 *
 * 1. Falha devolve `null`, nunca lista vazia. Lista vazia é uma AFIRMAÇÃO
 *    ("não há nada ativo lá fora") e faria a varredura concluir que o
 *    fornecedor está limpo toda vez que a rede caísse. `null` é a resposta
 *    honesta: não consegui perguntar.
 *
 * 2. Teto de páginas. Um `nextPageToken` que se repete — bug do fornecedor,
 *    resposta em cache, o que for — prenderia a vigília num laço para sempre.
 *    Vinte páginas cobrem qualquer volume real com folga larga; passar disso,
 *    devolve o que já leu em vez de travar o processo.
 */
export async function listarSessoesJules(deps: {
  apiKey?: string | undefined
  /** Tamanho da página; padrão 100. */
  pageSize?: number | undefined
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<SessaoListada[] | null> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return null
  const f = deps.fetchImpl ?? fetch
  const pageSize = deps.pageSize ?? 100

  const sessoes: SessaoListada[] = []
  const nomesJaVistos = new Set<string>()
  // Tokens já usados. O teto de páginas sozinho não bastava: um
  // `nextPageToken` que se repete faz o laço reler A MESMA página até bater no
  // teto, e a lista sai com vinte cópias de cada sessão. Rio abaixo isso é
  // grave — a reconciliação tem teto de dez arquivamentos por varredura, e dez
  // cópias de uma sessão gastariam o teto inteiro devolvendo UMA vaga, com o
  // relatório afirmando que havia vinte vezes mais órfãs do que existia.
  const tokensJaUsados = new Set<string>()
  let pageToken: string | undefined
  try {
    for (let pagina = 0; pagina < MAX_PAGINAS_DA_LISTAGEM; pagina += 1) {
      const url =
        `${JULES_API}/sessions?pageSize=${pageSize}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
      const resp = await f(url, {
        headers: { 'X-Goog-Api-Key': deps.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!resp.ok) {
        warn(`[jules] não foi possível listar as sessões (HTTP ${resp.status})`)
        return null
      }
      const body = (await resp.json().catch(() => ({}))) as {
        sessions?: Array<{ name?: string; archived?: boolean; createTime?: string }>
        nextPageToken?: string
      }
      for (const s of body.sessions ?? []) {
        // Sem nome não há o que arquivar depois — descartar é melhor que
        // carregar uma entrada quebrada até a hora de usá-la.
        if (!s.name) continue
        // Segunda linha de defesa contra a mesma classe de problema: mesmo com
        // tokens bem-comportados, uma sessão repetida entre páginas nunca pode
        // virar duas entradas.
        if (nomesJaVistos.has(s.name)) continue
        nomesJaVistos.add(s.name)
        sessoes.push({
          sessionName: s.name,
          archived: s.archived === true,
          criadaEm: s.createTime ?? null,
        })
      }
      if (!body.nextPageToken) return sessoes
      if (tokensJaUsados.has(body.nextPageToken)) {
        warn(
          `[jules] a listagem devolveu um cursor repetido; parando com ` +
            `${sessoes.length} sessões lidas em vez de girar em falso`
        )
        return sessoes
      }
      tokensJaUsados.add(body.nextPageToken)
      pageToken = body.nextPageToken
    }
    warn(
      `[jules] listagem de sessões parou no teto de ${MAX_PAGINAS_DA_LISTAGEM} páginas; ` +
        `seguindo com as ${sessoes.length} já lidas`
    )
    return sessoes
  } catch (err) {
    warn(`[jules] falha ao listar as sessões: ${(err as Error).message}`)
    return null
  }
}

/** POST em um método da sessão, com o mesmo contrato de degradação do resto. */
async function chamarMetodoDaSessao(deps: {
  apiKey?: string | undefined
  sessionName: string
  metodo: 'sendMessage' | 'approvePlan' | 'archive'
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

/**
 * Encerra a sessão do lado do fornecedor, liberando a vaga.
 *
 * Existe porque a falta dele estava matando a delegação. O produto criava
 * sessão e nunca encerrava nenhuma: `fecharSessao` só apagava a linha da
 * vigília AQUI, e lá fora a conversa seguia viva para sempre, segurando uma
 * vaga. Medido em 21/08/2026: onze recusas de criação com
 * `FAILED_PRECONDITION` e as dezoito vagas ativas do fornecedor ocupadas —
 * todas em "esperando resposta". Cada delegação consumia uma vaga em
 * definitivo, então a esteira tinha prazo de validade.
 *
 * `:archive` foi encontrado testando a API de verdade: `:cancel` e
 * `:complete` respondem 404, `:archive` responde 200 e a sessão passa a
 * `state=PAUSED`, `archived=true`.
 */
export async function arquivarSessaoJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<boolean> {
  return chamarMetodoDaSessao({ ...deps, metodo: 'archive', corpo: {} })
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
