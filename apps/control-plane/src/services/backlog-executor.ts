import { validateDoD, DOD_FIELD_MAP, type DoDFields } from '@gitorch/cadence'

// Backlog-executor: as MÃOS determinísticas da Lei "LLM decide, sistema
// executa". Recebe o plano que o PO preencheu (formulários já validados por
// schema) e o aplica no GitHub como árvore de sub-issues
// (wish→fase→épico→feature→task) + board + roadmap (milestones de sprint) +
// delegação. Idempotente por marker no corpo da issue: re-executar o mesmo
// plano não duplica nada.

export interface IssueRef {
  number: number
  nodeId: string
}

/** Superfície mínima de GitHub que o executor precisa (injetável p/ teste). */
export interface BacklogGitHub {
  /** Procura issue existente pelo marker de idempotência no corpo. */
  findIssueByMarker(marker: string): Promise<IssueRef | null>
  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<IssueRef>
  addSubIssue(parentNodeId: string, childNodeId: string): Promise<void>
  /** Adiciona a issue ao board; devolve o id do item no Projects v2. */
  addToBoard(nodeId: string): Promise<string>
  /** Aponta o item do board para a iteração da sprint N (se o campo existir). */
  setSprint(boardItemId: string, sprint: number): Promise<void>
  addLabels(nodeId: string, labels: string[]): Promise<void>
  /** Publica o Sprint Goal no board (status update) — visível ao cliente. */
  postSprintGoal?(goal: string): Promise<void>
  /** Seta a coluna de status do card (nome vem da config do projeto). */
  setStatus?(boardItemId: string, column: 'todo'): Promise<void>
  /** Associa a issue ao milestone "Sprint N" (criado com data se faltar). */
  setMilestone?(issueNumber: number, sprint: number): Promise<void>
}

export interface BacklogPlan {
  wish: IssueRef
  /** Quantas jornadas o RA escreveu (0 = plano sem RA; cobertura não exigida). */
  journeysCount: number
  phases: Array<{ title: string; goal: string; rationale: string }>
  epics: Array<{
    phaseIndex: number
    title: string
    description: string
    journeyIndexes: number[]
  }>
  features: Array<{ epicIndex: number; title: string; description: string }>
  tasks: Array<{
    featureIndex: number
    fields: DoDFields
    /** Índices (em tasks) de dependências "blocked by" declaradas pelo PO. */
    blockedByTaskIndexes?: number[]
  }>
  roadmap: { sprintGoal: string; assignments: Array<{ taskIndex: number; sprint: number }> }
}

export interface ApplyBacklogOptions {
  github: BacklogGitHub
  plan: BacklogPlan
  /** Label de delegação para tasks prontas (ex.: 'jules'); ausente = não delega. */
  delegateLabel?: string
}

export interface ApplyBacklogResult {
  createdCount: number
  skippedCount: number
  sprintsPlanned: number
  issues: Array<{ marker: string; ref: IssueRef }>
}

/** Corpo canônico da issue: os 8 campos do DoD, na ordem, + marker invisível. */
export function renderIssueBody(fields: DoDFields, marker: string): string {
  // Derivado da fonte única do DoD: cabeçalho e valor vêm do MESMO mapa —
  // impossível publicar seção vazia por descasamento de chave.
  const sections = DOD_FIELD_MAP.map(({ key, header }) => `## ${header}\n\n${fields[key]}`)
  return [`<!-- ${marker} -->`, ...sections].join('\n\n')
}

/** Corpo simples (fases/épicos/features não carregam DoD de execução). */
function renderNodeBody(lines: string[], marker: string): string {
  return [`<!-- ${marker} -->`, ...lines].join('\n\n')
}

/**
 * Validação TOTAL do plano ANTES de criar qualquer issue (all-or-nothing).
 * É aqui que o CÓDIGO rejeita plano raso ou incoerente: jornada ignorada,
 * épico sem feature, feature sem task, dependência para frente, task fora do
 * roadmap. Exportada para teste direto.
 */
export function validateBacklogPlan(plan: BacklogPlan): string[] {
  const problems: string[] = []

  plan.epics.forEach((epic, i) => {
    if (epic.phaseIndex < 0 || epic.phaseIndex >= plan.phases.length) {
      problems.push(`epics[${i}]: phaseIndex ${epic.phaseIndex} out of range`)
    }
    for (const j of epic.journeyIndexes) {
      if (!Number.isInteger(j) || j < 0 || j >= plan.journeysCount) {
        problems.push(`epics[${i}]: journeyIndex ${j} out of range (0..${plan.journeysCount - 1})`)
      }
    }
  })

  // Toda jornada do RA precisa estar coberta por >=1 épico — plano que ignora
  // uma jornada é exatamente o "plano raso" que o dono do produto rejeitou.
  if (plan.journeysCount > 0) {
    const covered = new Set(plan.epics.flatMap((e) => e.journeyIndexes))
    for (let j = 0; j < plan.journeysCount; j++) {
      if (!covered.has(j)) problems.push(`journey ${j} is not covered by any epic`)
    }
  }

  plan.features.forEach((feature, i) => {
    if (feature.epicIndex < 0 || feature.epicIndex >= plan.epics.length) {
      problems.push(`features[${i}]: epicIndex ${feature.epicIndex} out of range`)
    }
  })
  plan.epics.forEach((_, e) => {
    if (!plan.features.some((f) => f.epicIndex === e)) {
      problems.push(`epics[${e}]: has no feature`)
    }
  })

  plan.tasks.forEach((task, i) => {
    const dod = validateDoD(task.fields)
    if (!dod.ok) problems.push(`tasks[${i}]: ${dod.errors.join('; ')}`)
    if (task.featureIndex < 0 || task.featureIndex >= plan.features.length) {
      problems.push(`tasks[${i}]: featureIndex ${task.featureIndex} out of range`)
    }
    for (const b of task.blockedByTaskIndexes ?? []) {
      if (!Number.isInteger(b) || b < 0 || b >= i) {
        problems.push(`tasks[${i}]: blockedBy ${b} must reference an EARLIER task`)
      }
    }
  })
  plan.features.forEach((_, f) => {
    if (!plan.tasks.some((t) => t.featureIndex === f)) {
      problems.push(`features[${f}]: has no task`)
    }
  })

  // Roadmap: TODA task tem sprint (>=1, inteiro), sem duplicata, e nenhuma
  // task entra em sprint anterior à de um bloqueador.
  const sprintByTask = new Map<number, number>()
  for (const a of plan.roadmap.assignments) {
    if (!Number.isInteger(a.taskIndex) || a.taskIndex < 0 || a.taskIndex >= plan.tasks.length) {
      problems.push(`roadmap: taskIndex ${a.taskIndex} out of range`)
      continue
    }
    if (!Number.isInteger(a.sprint) || a.sprint < 1) {
      problems.push(`roadmap: task ${a.taskIndex} has invalid sprint ${a.sprint}`)
      continue
    }
    if (sprintByTask.has(a.taskIndex)) {
      problems.push(`roadmap: task ${a.taskIndex} assigned twice`)
      continue
    }
    sprintByTask.set(a.taskIndex, a.sprint)
  }
  plan.tasks.forEach((task, i) => {
    const sprint = sprintByTask.get(i)
    if (sprint === undefined) {
      problems.push(`roadmap: task ${i} has no sprint`)
      return
    }
    for (const b of task.blockedByTaskIndexes ?? []) {
      const blockerSprint = sprintByTask.get(b)
      if (blockerSprint !== undefined && blockerSprint > sprint) {
        problems.push(
          `roadmap: task ${i} (sprint ${sprint}) depends on task ${b} (sprint ${blockerSprint})`
        )
      }
    }
  })

  return problems
}

export async function applyBacklog(options: ApplyBacklogOptions): Promise<ApplyBacklogResult> {
  const { github, plan } = options

  const problems = validateBacklogPlan(plan)
  if (problems.length > 0) {
    throw new Error(`Backlog rejected by DoD/integrity validation: ${problems.join(' | ')}`)
  }

  const sprintByTask = new Map(plan.roadmap.assignments.map((a) => [a.taskIndex, a.sprint]))
  const sprintsPlanned = Math.max(...plan.roadmap.assignments.map((a) => a.sprint))

  const result: ApplyBacklogResult = {
    createdCount: 0,
    skippedCount: 0,
    sprintsPlanned,
    issues: [],
  }

  // Cada card criado nasce na coluna inicial ("todo" no mapa do projeto) — o
  // board é a interface do cliente; card sem status parece esquecido.
  const addToBoardWithStatus = async (nodeId: string): Promise<string> => {
    const itemId = await github.addToBoard(nodeId)
    if (github.setStatus) await github.setStatus(itemId, 'todo')
    return itemId
  }

  // Cria (ou reusa, por marker) um nó e o coloca no board e na árvore.
  // `labels`: marca o TIPO do nó (ex.: `gitorch:task`) para o SM achar as tasks
  // delegáveis (folhas) sem confundir com épicos/features.
  const ensureNode = async (
    marker: string,
    title: string,
    body: string,
    parentNodeId: string,
    labels?: string[]
  ): Promise<IssueRef> => {
    const existing = await github.findIssueByMarker(marker)
    if (existing) {
      result.skippedCount += 1
      result.issues.push({ marker, ref: existing })
      return existing
    }
    const ref = await github.createIssue({ title, body, ...(labels ? { labels } : {}) })
    result.createdCount += 1
    result.issues.push({ marker, ref })
    await github.addSubIssue(parentNodeId, ref.nodeId)
    return ref
  }

  // 2) Fases sob a wish.
  const phaseRefs: IssueRef[] = []
  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i]!
    const marker = `gitorch:node:${plan.wish.number}:phase:${i}`
    const ref = await ensureNode(
      marker,
      phase.title,
      renderNodeBody([`**Goal**: ${phase.goal}`, `**Rationale**: ${phase.rationale}`], marker),
      plan.wish.nodeId
    )
    phaseRefs.push(ref)
    await addToBoardWithStatus(ref.nodeId)
  }

  // 3) Épicos sob suas fases (com as jornadas que cobrem, visíveis ao cliente).
  const epicRefs: IssueRef[] = []
  for (let i = 0; i < plan.epics.length; i++) {
    const epic = plan.epics[i]!
    const marker = `gitorch:node:${plan.wish.number}:epic:${i}`
    const journeyLine =
      epic.journeyIndexes.length > 0
        ? [`**Covers journeys**: ${epic.journeyIndexes.map((j) => `#${j}`).join(', ')}`]
        : []
    const ref = await ensureNode(
      marker,
      epic.title,
      renderNodeBody([epic.description, ...journeyLine], marker),
      phaseRefs[epic.phaseIndex]!.nodeId
    )
    epicRefs.push(ref)
    await addToBoardWithStatus(ref.nodeId)
  }

  // 4) Features sob seus épicos.
  const featureRefs: IssueRef[] = []
  for (let i = 0; i < plan.features.length; i++) {
    const feature = plan.features[i]!
    const marker = `gitorch:node:${plan.wish.number}:feature:${i}`
    const ref = await ensureNode(
      marker,
      feature.title,
      renderNodeBody([feature.description], marker),
      epicRefs[feature.epicIndex]!.nodeId
    )
    featureRefs.push(ref)
    await addToBoardWithStatus(ref.nodeId)
  }

  // 5) Tasks sob suas features: DoD completo, dependências, sprint (milestone
  //    datado + iteração do board) e delegação quando prontas na sprint 1.
  const taskRefs: IssueRef[] = []
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i]!
    const marker = `gitorch:node:${plan.wish.number}:task:${i}`
    const blocked = (task.blockedByTaskIndexes ?? [])
      .map((b) => taskRefs[b]?.number)
      .filter((n): n is number => typeof n === 'number')
    const blockedLine =
      blocked.length > 0 ? `\n\nBlocked by ${blocked.map((n) => `#${n}`).join(', ')}` : ''
    const ref = await ensureNode(
      marker,
      task.fields.titulo,
      renderIssueBody(task.fields, marker) + blockedLine,
      featureRefs[task.featureIndex]!.nodeId,
      // Só TASK é unidade delegável; a label deixa o SM achá-las.
      ['gitorch:task']
    )
    taskRefs.push(ref)
    const boardItem = await addToBoardWithStatus(ref.nodeId)

    const sprint = sprintByTask.get(i)!
    await github.setSprint(boardItem, sprint)
    if (github.setMilestone) await github.setMilestone(ref.number, sprint)
  }

  // 6) Sprint Goal + tamanho do roadmap visíveis no board — o cliente sabe em
  //    qual fase está e quantas sprints o plano tem.
  if (plan.roadmap.sprintGoal && github.postSprintGoal) {
    await github.postSprintGoal(
      `${plan.roadmap.sprintGoal} (Sprint 1 of ${sprintsPlanned} planned)`
    )
  }

  // 7) Delegação: tasks da SPRINT 1 sem dependência aberta ganham a label — o
  //    resto o SM libera quando os bloqueadores fecharem (delegação contínua).
  if (options.delegateLabel) {
    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i]!
      const ref = taskRefs[i]!
      const isBlocked = (task.blockedByTaskIndexes ?? []).length > 0
      if (sprintByTask.get(i) === 1 && !isBlocked) {
        await github.addLabels(ref.nodeId, [options.delegateLabel])
      }
    }
  }

  return result
}
