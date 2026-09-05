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
 * Uma atividade de um dos DOIS originadores que participam da conversa, já
 * validada e pronta para decisão.
 *
 * Até a L5-T5 só existia o lado do agente (`AtividadeDoAgente`, nome antigo
 * deste tipo) — o suficiente para "qual foi a última pergunta" e "houve sinal
 * de vida". O catálogo de dúvidas (D75, 05/09) precisa dos DOIS lados: a
 * pergunta do dev (`agentMessaged`) E a resposta que O TIME mandou
 * (`userMessaged`) — sem o segundo lado não dá para saber se uma pergunta
 * ficou sem resposta.
 */
interface AtividadeDaSessao {
  originator: 'agent' | 'user'
  /** `Date.parse(createTime)` — já filtrado de `NaN`. */
  quando: number
  /**
   * Texto de `agentMessaged.agentMessage` (agent) ou `userMessaged.userMessage`
   * (user), ou string vazia quando a atividade não é mensagem (progressUpdated,
   * artifacts, sessionCompleted, planGenerated, planApproved, …).
   */
  texto: string
}

/**
 * Busca e normaliza a página de atividades da sessão, mantendo o que veio dos
 * DOIS originadores que fazem parte da conversa (`agent` e `user`) com
 * `createTime` válido — qualquer outro originador (se algum dia existir) é
 * descartado aqui, na fonte única.
 *
 * Compartilhada por `ultimaMensagemDoDevJules` (só o lado `agent`, texto não
 * vazio), `houveAtividadeDoDevDesde` (L5-T3, só o lado `agent`, sem filtrar
 * texto — uma `progressUpdated` ou `artifacts` sem mensagem nenhuma ainda é
 * sinal de vida do agente) e `atividadesDeConversaJules` (L5-T5/D75, os DOIS
 * lados, só com texto — é o catálogo de pergunta/resposta). Continua sendo A
 * ÚNICA função que fala com o endpoint de atividades: as três de cima
 * filtram o que já veio daqui, nunca refazem a chamada — mesmo raciocínio de
 * reaproveitar `hashDaMensagem` em `session-watch.ts` em vez de cópias
 * locais.
 *
 * A API não documenta a ordem de retorno de `activities.list`, então não dá
 * para confiar que o último item da página é o mais recente — quem chama
 * decide "mais recente" ou "existe alguma depois de X" olhando `quando`.
 * `pageSize=100` (o teto da API) cobre a folga de uma sessão comum numa
 * página só; sessões com histórico maior que isso são o caso raro que este
 * contrato de degradação aceita (mesma classe de "melhor esforço" do resto
 * deste módulo).
 *
 * Mesmo contrato de degradação do resto do arquivo: nunca lança. Sem chave,
 * sem atividade relevante ou serviço fora do ar devolvem lista vazia, com
 * aviso.
 */
async function buscarAtividadesDaSessao(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<AtividadeDaSessao[]> {
  const warn = deps.onWarn ?? (() => undefined)
  if (!deps.apiKey) return []
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
      return []
    }
    const body = (await resp.json().catch(() => ({}))) as {
      activities?: Array<{
        originator?: string
        createTime?: string
        agentMessaged?: { agentMessage?: string }
        userMessaged?: { userMessage?: string }
      }>
    }
    const atividades = Array.isArray(body.activities) ? body.activities : []

    const resultado: AtividadeDaSessao[] = []
    for (const atividade of atividades) {
      const originator = (atividade.originator ?? '').toLowerCase()
      if (originator !== 'agent' && originator !== 'user') continue
      const quando = atividade.createTime ? Date.parse(atividade.createTime) : NaN
      if (Number.isNaN(quando)) continue
      const texto =
        originator === 'agent'
          ? atividade.agentMessaged?.agentMessage
          : atividade.userMessaged?.userMessage
      resultado.push({ originator, quando, texto: typeof texto === 'string' ? texto : '' })
    }
    return resultado
  } catch (err) {
    warn(
      `[jules] falha ao ler as atividades da sessão ${deps.sessionName}: ${(err as Error).message}`
    )
    return []
  }
}

/**
 * Lê a última mensagem que o dev assíncrono mandou nesta sessão — é o que a
 * vigia usa para decidir uma pergunta pendente e para o hash de idempotência
 * (não responder duas vezes à mesma pergunta).
 *
 * Mesmo contrato de degradação do resto do arquivo: nunca lança. Sem chave,
 * sem atividade do agente ou serviço fora do ar devolvem string vazia, com
 * aviso (dentro de `buscarAtividadesDoAgente`).
 */
export async function ultimaMensagemDoDevJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<string> {
  const atividades = (await buscarAtividadesDaSessao(deps)).filter((a) => a.originator === 'agent')

  let maisRecente: AtividadeDaSessao | null = null
  for (const atividade of atividades) {
    if (atividade.texto.length === 0) continue
    if (!maisRecente || atividade.quando > maisRecente.quando) {
      maisRecente = atividade
    }
  }
  return maisRecente?.texto ?? ''
}

/**
 * L5-T3 — sinal de vida independente de `session.updateTime`.
 *
 * `jules-session-loop.ts` decidia abandonar uma sessão só pela contagem cega
 * de nudges, com `paradoHaMs` vindo de `session.updateTime` (`consultarSessaoJules`).
 * Esse carimbo de topo NEM SEMPRE acompanha trabalho real — medido em
 * produção: 48 das 86 sessões abandonadas na história do produto morreram
 * ainda `IN_PROGRESS`, média de 3,4 nudges e só 10 com pull request. Esta
 * função olha a página de atividades DIRETO (`progressUpdated`, `artifacts`,
 * `agentMessaged`, `sessionCompleted` — tudo do ORIGINADOR agente) em vez de
 * confiar só no carimbo de topo, e diz se algo aconteceu depois de `desde`.
 *
 * Mesmo contrato de degradação do resto do arquivo: sem chave, sem atividade
 * do agente ou serviço fora do ar devolvem `false` — "sem prova de vida" é a
 * leitura conservadora quando não dá para confirmar nada, e é o que preserva
 * o comportamento de abandono de hoje quando o sinal não pode ser lido.
 */
export async function houveAtividadeDoDevDesde(deps: {
  apiKey?: string | undefined
  sessionName: string
  /** Instante de referência — tipicamente `lastProgressAt` da linha. */
  desde: Date
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<boolean> {
  const atividades = (await buscarAtividadesDaSessao(deps)).filter((a) => a.originator === 'agent')
  const desdeMs = deps.desde.getTime()
  return atividades.some((atividade) => atividade.quando > desdeMs)
}

/**
 * Uma mensagem de VERDADE da conversa — pergunta do dev ou resposta que O
 * TIME deu — pronta para o catálogo de dúvidas (L5-T5/D75).
 */
export interface AtividadeDaConversaJules {
  originator: 'agent' | 'user'
  quando: Date
  texto: string
}

/**
 * A conversa INTEIRA da sessão — cada pergunta do dev (`agentMessaged`) e
 * cada resposta que O TIME mandou (`userMessaged`) — para o catálogo de
 * dúvidas (L5-T5, decisão do dono D75 de 05/09: "tem que ter sistema que
 * coleta todas essas dúvidas pra que nas próximas tasks o RA e PO não gerem
 * dúvidas").
 *
 * Diferente de `ultimaMensagemDoDevJules` (só a última do agente) e
 * `houveAtividadeDoDevDesde` (só existência, indiferente a texto), esta
 * devolve TODAS as mensagens com texto não vazio, dos DOIS lados — na ordem
 * em que a API as devolveu (não documentada; quem grava decide dedup pelo
 * `momento` de cada uma, nunca pela posição na lista).
 *
 * Mesmo contrato de degradação do resto do arquivo: nunca lança. Sem chave,
 * sem mensagem com texto ou serviço fora do ar devolvem lista vazia.
 */
export async function atividadesDeConversaJules(deps: {
  apiKey?: string | undefined
  sessionName: string
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<AtividadeDaConversaJules[]> {
  const atividades = await buscarAtividadesDaSessao(deps)
  return atividades
    .filter((a) => a.texto.length > 0)
    .map((a) => ({ originator: a.originator, quando: new Date(a.quando), texto: a.texto }))
}
