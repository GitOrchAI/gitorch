import {
  ProjectV2Client,
  CampoDeIteracaoAusenteError,
  CampoNumericoAusenteError,
  NomeDeCampoEmConflitoError,
} from '@gitorch/github-sync'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import type { BacklogGitHub, IssueRef } from './backlog-executor.js'
import { GithubExecutionError } from './github-errors.js'
import { createBoardStatus, type BoardColumns } from './board-status.js'
import { fetchComTeto } from './fetch-com-teto.js'
import { hojeNoFuso, sprintCorrente, type Iteracao } from './garantir-sprint.js'

// Adapter GitHub REAL do backlog-executor: implementa a superfície BacklogGitHub
// com REST (issues/labels/busca) + ProjectV2Client (árvore, board, sprint).
// É a ÚNICA fronteira do plano do PO com o GitHub — toda ação auditável aqui.

export { GithubExecutionError } from './github-errors.js'

export interface GithubBacklogOptions {
  token: string
  /** ex.: "owner/repo" */
  repository: string
  /**
   * Node id do Project v2 (board). AUSENTE quando o projeto não tem quadro —
   * hoje isso acontece em repositório de conta pessoal, onde a credencial do
   * produto não consegue criar nem sequer enxergar quadro.
   *
   * Sem quadro o backlog continua sendo criado: issues, a árvore entre elas e
   * os marcos são trabalho de repositório e não dependem de board. O que se
   * perde é só a vitrine — card, coluna, iteração e o recado de sprint. Antes
   * desta separação o produto desistia das duas coisas juntas, e o cliente que
   * não podia ter quadro também não recebia backlog nenhum.
   */
  projectId?: string | undefined
  /** nome do campo de iteração no board (padrão "Sprint") */
  sprintFieldName?: string
  /** nome do campo de status no board (padrão "Status") */
  statusFieldName?: string
  /** nome do campo numérico de tamanho no board (padrão "Peso") */
  weightFieldName?: string
  /** mapeamento de colunas do projeto (config por projeto; default nativo). */
  statusColumns?: BoardColumns
  /** duração de cada sprint em dias (config por projeto; padrão 7). */
  sprintDays?: number
  /**
   * O dia de hoje NO FUSO DO DONO (formato do GitHub, YYYY-MM-DD).
   *
   * Existe porque `setSprint` precisa saber qual ciclo está correndo para não
   * deixar task nenhuma fora da sprint, e porque o dia tem que ser o mesmo que
   * o painel mostra: com UTC, entre 21h e a meia-noite de Brasília quem lê e
   * quem escreve discordam por até 3 horas.
   */
  hoje?: () => string
  fetchImpl?: typeof fetch
}

export function createGithubBacklog(options: GithubBacklogOptions): BacklogGitHub {
  // IMPORTANTE (leva D): alcançável pelo tique (scheduler.ts, wake do PO,
  // via `runPoMissionViaRails`) sob `tickEmAndamento` — mesma classe de
  // defeito do Crítico. `fetchImpl: f` (não `options.fetchImpl` cru) —
  // `ProjectV2Client` não tem teto próprio.
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = fetchComTeto(options.fetchImpl ?? fetchSemPermissao())
  const client = new ProjectV2Client({
    token: options.token,
    fetchImpl: f,
  })
  const sprintField = options.sprintFieldName ?? 'Sprint'
  const hoje = options.hoje ?? ((): string => hojeNoFuso())
  const weightField = options.weightFieldName ?? 'Peso'

  const rest = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      throw new GithubExecutionError(
        `GitHub REST ${method} ${path} failed (${response.status}): ${JSON.stringify(json).slice(0, 200)}`
      )
    }
    return json
  }

  // Helper GraphQL ÚNICO do adapter (o client cobre as mutations tipadas; este
  // cobre consultas ad-hoc). Sempre valida errors[] — nada de undefined mudo.
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const resp = await f('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        'user-agent': 'gitorch',
      },
      body: JSON.stringify({ query, variables }),
    })
    const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      throw new GithubExecutionError(`GitHub GraphQL failed: ${json.errors[0]?.message}`)
    }
    if (!json.data) throw new GithubExecutionError('GitHub GraphQL returned no data')
    return json.data
  }

  // Idempotência com UMA busca por wish (a Search API tem limite de ~30 req/min;
  // uma chamada por nó estouraria em planos grandes): busca todos os corpos com
  // o prefixo do marker da wish e monta o mapa marker→issue em memória.
  const markerMaps = new Map<string, Map<string, IssueRef>>()
  const markerPrefix = (marker: string): string => {
    // "gitorch:node:<wish>:tipo:i" → "gitorch:node:<wish>"
    return marker.split(':').slice(0, 3).join(':')
  }
  const loadMarkers = async (prefix: string): Promise<Map<string, IssueRef>> => {
    const cached = markerMaps.get(prefix)
    if (cached) return cached
    const map = new Map<string, IssueRef>()
    const q = encodeURIComponent(`repo:${options.repository} in:body "${prefix}" state:open`)
    const result = (await rest('GET', `/search/issues?q=${q}&per_page=100`)) as {
      items?: Array<{ number: number; node_id: string; body?: string }>
    }
    for (const item of result.items ?? []) {
      const found = item.body?.match(/<!--\s*(gitorch:node:[^\s>]+)\s*-->/)
      if (found?.[1]) map.set(found[1], { number: item.number, nodeId: item.node_id })
    }
    markerMaps.set(prefix, map)
    return map
  }

  /** Sem quadro não há onde pendurar card: os passos de vitrine viram silêncio útil. */
  const quadro = options.projectId

  const boardStatus = quadro
    ? createBoardStatus({
        token: options.token,
        projectId: quadro,
        ...(options.statusFieldName ? { statusFieldName: options.statusFieldName } : {}),
        ...(options.statusColumns ? { columns: options.statusColumns } : {}),
        // O `f` DESTE arquivo, e não `options.fetchImpl`: em produção o
        // chamador não passa fetchImpl nenhum, então repassar o cru deixava o
        // movimento de card no quadro do cliente sair sem teto de tempo E sem
        // a guarda de autonomia. `f` já carrega os dois.
        fetchImpl: f,
      })
    : null

  // Cache do campo de iteração (resolvido uma vez por execução do plano).
  //
  // Guarda a iteração INTEIRA (título, início e duração), e não só o id: sem as
  // datas não dá para saber qual ciclo está correndo, e era por isso que toda
  // task além do horizonte de iterações configuradas saía sem sprint nenhuma.
  let sprintCache: { fieldId: string; iterations: Iteracao[] } | null | undefined

  const resolveSprint = async (): Promise<{
    fieldId: string
    iterations: Iteracao[]
  } | null> => {
    if (sprintCache !== undefined) return sprintCache
    if (!quadro) return (sprintCache = null)
    try {
      const field = await client.getIterationField({
        projectId: quadro,
        fieldName: sprintField,
      })
      sprintCache =
        field.iterations.length > 0
          ? { fieldId: field.fieldId, iterations: field.iterations }
          : null
    } catch (error) {
      // Só a AUSÊNCIA do campo Sprint é tolerada (board sem iteração configurada).
      // Qualquer outra falha (FORBIDDEN, rede) é real e deve subir — engolir aqui
      // perderia o Sprint Planning inteiro em silêncio.
      //
      // Era comparação por TEXTO da mensagem ('not found'), que é frágil: a
      // mensagem do GitHub muda e um erro de permissão pode conter as mesmas
      // palavras. Agora é um tipo próprio de erro.
      if (!(error instanceof CampoDeIteracaoAusenteError)) {
        throw error instanceof GithubExecutionError
          ? error
          : new GithubExecutionError(`resolveSprint failed: ${String(error).slice(0, 200)}`)
      }
      sprintCache = null
    }
    return sprintCache
  }

  // Campo numérico "Peso" — a resposta ao "não vejo visualmente no GitHub".
  // Resolvido UMA vez por execução do plano (o cache também é o que impede uma
  // segunda tentativa de criação depois da primeira ter dado certo).
  //
  // A ordem é ler-depois-criar, e não o contrário, pela cicatriz do campo
  // Sprint: criar às cegas devolve "Name has already been taken" (confirmado
  // ao vivo em 31/08/2026) e o produto repetiria isso a cada tique, para
  // sempre, sem ninguém entender por quê.
  let pesoCache: string | null | undefined

  const resolvePesoField = async (): Promise<string | null> => {
    if (pesoCache !== undefined) return pesoCache
    if (!quadro) return (pesoCache = null)
    try {
      const campo = await client.getNumberField({ projectId: quadro, fieldName: weightField })
      return (pesoCache = campo.fieldId)
    } catch (error) {
      if (error instanceof CampoNumericoAusenteError) {
        // O nome está livre: criar é o conserto certo.
        //
        // A falha da CRIAÇÃO não pode subir crua. Quando esta linha roda, o
        // `applyBacklog` JÁ criou as issues do plano: um `Error` anônimo do
        // cliente de GraphQL atravessando daqui derruba o plano no meio e
        // deixa o trabalho pela metade, sem o tipo que o resto do produto
        // reconhece. O irmão `resolveSprint`, logo acima, embrulha em
        // `GithubExecutionError` exatamente por isso — e a mensagem original
        // vai junto, senão ninguém descobre por que o quadro recusou.
        try {
          const criado = await client.criarCampoNumerico({
            projectId: quadro,
            fieldName: weightField,
          })
          return (pesoCache = criado.fieldId)
        } catch (falhaAoCriar) {
          throw falhaAoCriar instanceof GithubExecutionError
            ? falhaAoCriar
            : new GithubExecutionError(
                `criarCampoNumerico failed: ${String(falhaAoCriar).slice(0, 200)}`
              )
        }
      }
      if (error instanceof NomeDeCampoEmConflitoError) {
        // Alguém já tem um campo "Peso" de outro tipo. Só o dono resolve
        // (renomeando ou apagando); tentar criar de novo seria o laço eterno.
        // O card fica sem o número — o corpo da issue continua trazendo o peso
        // e o plano inteiro NÃO cai por causa da vitrine. O aviso é alto: sem
        // ele isto seria mascarar.
        // eslint-disable-next-line no-console
        console.warn(`[backlog] campo "${weightField}" existe com outro tipo: ${String(error)}`)
        return (pesoCache = null)
      }
      // Rede, 502, token sem autorização de quadro: erro real, sobe.
      throw error instanceof GithubExecutionError
        ? error
        : new GithubExecutionError(`resolvePesoField failed: ${String(error).slice(0, 200)}`)
    }
  }

  // Milestones "Sprint N" com data de entrega: o ROADMAP visível ao cliente.
  // Cache por número; criação idempotente por título.
  const sprintDays = options.sprintDays ?? 7
  const milestoneCache = new Map<number, number | null>()
  const ensureMilestone = async (sprintNumber: number): Promise<number | null> => {
    const cached = milestoneCache.get(sprintNumber)
    if (cached !== undefined) return cached
    const title = `Sprint ${sprintNumber}`
    const existing = (await rest(
      'GET',
      `/repos/${options.repository}/milestones?state=all&per_page=100`
    )) as Array<{ number: number; title: string }>
    const found = Array.isArray(existing) ? existing.find((m) => m.title === title) : undefined
    if (found) {
      milestoneCache.set(sprintNumber, found.number)
      return found.number
    }
    const dueOn = new Date(Date.now() + sprintNumber * sprintDays * 24 * 60 * 60 * 1000)
    const created = (await rest('POST', `/repos/${options.repository}/milestones`, {
      title,
      due_on: dueOn.toISOString(),
      description: `GitOrch roadmap: sprint ${sprintNumber} (${sprintDays}-day sprints)`,
    })) as { number?: number }
    const number = created.number ?? null
    milestoneCache.set(sprintNumber, number)
    return number
  }

  return {
    async findIssueByMarker(marker: string): Promise<IssueRef | null> {
      const map = await loadMarkers(markerPrefix(marker))
      return map.get(marker) ?? null
    },

    async createIssue(input): Promise<IssueRef> {
      const issue = (await rest('POST', `/repos/${options.repository}/issues`, {
        title: input.title,
        body: input.body,
        ...(input.labels ? { labels: input.labels } : {}),
      })) as { number: number; node_id: string }
      return { number: issue.number, nodeId: issue.node_id }
    },

    async addSubIssue(parentNodeId, childNodeId): Promise<void> {
      await client.addSubIssue({ issueId: parentNodeId, subIssueId: childNodeId })
    },

    async addToBoard(nodeId): Promise<string> {
      // Sem quadro, a issue já foi criada e continua valendo; o que não existe
      // é o card. Devolver vazio deixa os passos seguintes (status, sprint)
      // saberem que não há item para enfeitar.
      if (!quadro) return ''
      try {
        return await client.addItemById({ projectId: quadro, contentId: nodeId })
      } catch (error) {
        // Idempotência: "Content already exists in this project" não é falha —
        // resolve o id do item existente (ex.: workflow de auto-add do board).
        if (!String(error).includes('already exists')) throw error
        const data = await gql<{
          node?: { projectItems?: { nodes?: Array<{ id: string; project?: { id?: string } }> } }
        }>(
          `query($id: ID!) { node(id: $id) { ... on Issue {
            projectItems(first: 20) { nodes { id project { id } } } } } }`,
          { id: nodeId }
        )
        const item = data.node?.projectItems?.nodes?.find((n) => n.project?.id === quadro)
        if (!item) throw error
        return item.id
      }
    },

    async setSprint(boardItemId, sprintNumber): Promise<void> {
      const sprint = await resolveSprint()
      if (!sprint) return
      if (!quadro || !boardItemId) return

      // Sprint N → N-ésima iteração configurada no board. O caminho feliz.
      //
      // Quando N passa do que existe, o comportamento anterior era `return`
      // mudo — e não era caso raro: medido em 31/08/2026, o quadro #2 do dono
      // tinha UMA iteração configurada, então TODA task de sprint 2 ou adiante
      // saía sem ciclo, sem erro e sem log. O card aparecia no quadro com o
      // campo Sprint vazio e não havia como descobrir por quê.
      //
      // Agora cai no ciclo que está correndo hoje: é a sprint que o cliente vê
      // no painel, e ter a task lá é mais verdadeiro que não ter ciclo nenhum.
      const iteration =
        sprint.iterations[sprintNumber - 1] ?? sprintCorrente(sprint.iterations, hoje())
      if (!iteration) {
        // O último caso possível: nem a N-ésima existe, nem há ciclo correndo
        // hoje (o intervalo entre sprints). Aqui não há iteração certa para
        // escolher — mas o silêncio é que era o defeito, então isto é DITO.
        // eslint-disable-next-line no-console
        console.warn(
          `[backlog] item ${boardItemId} ficou fora da sprint ${sprintNumber}: ` +
            `o quadro tem ${sprint.iterations.length} iteração(ões) configurada(s) e ` +
            `nenhuma está correndo em ${hoje()}. O milestone datado continua valendo.`
        )
        return
      }

      await client.setIterationField({
        projectId: quadro,
        itemId: boardItemId,
        fieldId: sprint.fieldId,
        iterationId: iteration.id,
      })
    },

    async setWeight(boardItemId, weight): Promise<void> {
      if (!quadro || !boardItemId) return
      const fieldId = await resolvePesoField()
      if (!fieldId) return
      await client.setNumberField({
        projectId: quadro,
        itemId: boardItemId,
        fieldId,
        number: weight,
      })
    },

    async setMilestone(issueNumber, sprintNumber): Promise<void> {
      const milestone = await ensureMilestone(sprintNumber)
      if (milestone === null) return
      await rest('PATCH', `/repos/${options.repository}/issues/${issueNumber}`, {
        milestone,
      })
    },

    async postSprintGoal(goal: string): Promise<void> {
      // O Sprint Goal fica VISÍVEL no board (status update do Projects v2) — o
      // board é a interface do cliente; memória interna não basta.
      if (!quadro) return
      await client.createStatusUpdate({
        projectId: quadro,
        body: `Sprint Goal: ${goal}`,
        startDate: new Date().toISOString().slice(0, 10),
        status: 'ON_TRACK',
      })
    },

    async setStatus(boardItemId, column): Promise<void> {
      // Coluna/campo ausente no board do cliente não é falha do plano — o
      // status é acessório; a árvore/labels são o essencial. Sem board nenhum,
      // o acessório simplesmente não existe.
      if (!boardStatus || !boardItemId) return
      const outcome = await boardStatus.setStatus(boardItemId, column)
      if (outcome !== 'set') {
        // eslint-disable-next-line no-console
        console.warn(`[backlog] status não aplicado (${outcome}) para item ${boardItemId}`)
      }
    },

    async addLabels(nodeId, labels): Promise<void> {
      const data = await gql<{
        node?: { number?: number; repository?: { nameWithOwner?: string } }
      }>(
        `query($id: ID!) { node(id: $id) { ... on Issue { number repository { nameWithOwner } } } }`,
        { id: nodeId }
      )
      const number = data.node?.number
      const repo = data.node?.repository?.nameWithOwner ?? options.repository
      if (!number) {
        throw new GithubExecutionError(`addLabels: could not resolve issue number for ${nodeId}`)
      }
      await rest('POST', `/repos/${repo}/issues/${number}/labels`, { labels })
    },
  }
}
