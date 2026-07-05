import { validateDoD, DOD_FIELD_MAP, type DoDFields } from '@gitorch/cadence'

// Backlog-executor: as MÃOS determinísticas da Lei "LLM decide, sistema
// executa". Recebe o plano que o PO preencheu (formulários já validados por
// schema) e o aplica no GitHub como árvore de sub-issues
// (wish→fase→épico→feature→task) + board + sprint + delegação. Idempotente por
// marker no corpo da issue: re-executar o mesmo plano não duplica nada.

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
  /** Seta a iteração (Sprint) corrente no item do board. */
  setSprint(boardItemId: string): Promise<void>
  addLabels(nodeId: string, labels: string[]): Promise<void>
  /** Publica o Sprint Goal no board (status update) — visível ao cliente. */
  postSprintGoal?(goal: string): Promise<void>
}

export interface BacklogPlan {
  wish: IssueRef
  phases: Array<{ title: string; goal: string; rationale: string }>
  epics: Array<{ phaseIndex: number; title: string; description: string }>
  items: Array<{
    epicIndex: number
    kind: 'feature' | 'task'
    parentFeatureIndex?: number
    fields: DoDFields
    /** Índices (em items) de dependências "blocked by" declaradas pelo PO. */
    blockedByItemIndexes?: number[]
  }>
  sprint?: { sprintGoal: string; selectedItemIndexes: number[] }
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
  issues: Array<{ marker: string; ref: IssueRef }>
}

/** Corpo canônico da issue: os 8 campos do DoD, na ordem, + marker invisível. */
export function renderIssueBody(fields: DoDFields, marker: string): string {
  // Derivado da fonte única do DoD: cabeçalho e valor vêm do MESMO mapa —
  // impossível publicar seção vazia por descasamento de chave.
  const sections = DOD_FIELD_MAP.map(({ key, header }) => `## ${header}\n\n${fields[key]}`)
  return [`<!-- ${marker} -->`, ...sections].join('\n\n')
}

/** Corpo simples (fases/épicos não carregam DoD de execução). */
function renderNodeBody(lines: string[], marker: string): string {
  return [`<!-- ${marker} -->`, ...lines].join('\n\n')
}

export async function applyBacklog(options: ApplyBacklogOptions): Promise<ApplyBacklogResult> {
  const { github, plan } = options

  // 1) Validação TOTAL antes de qualquer criação (all-or-nothing): DoD por
  //    código em todos os itens + integridade dos índices do plano.
  const problems: string[] = []
  plan.items.forEach((item, i) => {
    const dod = validateDoD(item.fields)
    if (!dod.ok) problems.push(`items[${i}]: ${dod.errors.join('; ')}`)
    if (item.epicIndex < 0 || item.epicIndex >= plan.epics.length) {
      problems.push(`items[${i}]: epicIndex ${item.epicIndex} out of range`)
    }
    // O plano vem da LLM: referências de pai/dependência precisam ser
    // BACKWARD (apontar para item anterior) e do tipo certo — senão o loop de
    // criação quebraria DEPOIS de já ter criado nós (fim do all-or-nothing).
    if (item.parentFeatureIndex !== undefined) {
      const p = item.parentFeatureIndex
      if (!Number.isInteger(p) || p < 0 || p >= i) {
        problems.push(`items[${i}]: parentFeatureIndex ${p} must reference an EARLIER item`)
      } else if (plan.items[p]?.kind !== 'feature') {
        problems.push(`items[${i}]: parentFeatureIndex ${p} does not point to a feature`)
      }
    }
    for (const b of item.blockedByItemIndexes ?? []) {
      if (!Number.isInteger(b) || b < 0 || b >= i) {
        problems.push(`items[${i}]: blockedBy ${b} must reference an EARLIER item`)
      }
    }
  })
  plan.epics.forEach((epic, i) => {
    if (epic.phaseIndex < 0 || epic.phaseIndex >= plan.phases.length) {
      problems.push(`epics[${i}]: phaseIndex ${epic.phaseIndex} out of range`)
    }
  })
  if (problems.length > 0) {
    throw new Error(`Backlog rejected by DoD/integrity validation: ${problems.join(' | ')}`)
  }

  const result: ApplyBacklogResult = { createdCount: 0, skippedCount: 0, issues: [] }

  // Cria (ou reusa, por marker) um nó e o coloca no board e na árvore.
  const ensureNode = async (
    marker: string,
    title: string,
    body: string,
    parentNodeId: string
  ): Promise<IssueRef> => {
    const existing = await github.findIssueByMarker(marker)
    if (existing) {
      result.skippedCount += 1
      result.issues.push({ marker, ref: existing })
      return existing
    }
    const ref = await github.createIssue({ title, body })
    result.createdCount += 1
    result.issues.push({ marker, ref })
    await github.addSubIssue(parentNodeId, ref.nodeId)
    return ref
  }

  // 2) Fases sob a wish.
  const phaseRefs: IssueRef[] = []
  const boardItemByNode = new Map<string, string>()
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
    boardItemByNode.set(ref.nodeId, await github.addToBoard(ref.nodeId))
  }

  // 3) Épicos sob suas fases.
  const epicRefs: IssueRef[] = []
  for (let i = 0; i < plan.epics.length; i++) {
    const epic = plan.epics[i]!
    const marker = `gitorch:node:${plan.wish.number}:epic:${i}`
    const ref = await ensureNode(
      marker,
      epic.title,
      renderNodeBody([epic.description], marker),
      phaseRefs[epic.phaseIndex]!.nodeId
    )
    epicRefs.push(ref)
    boardItemByNode.set(ref.nodeId, await github.addToBoard(ref.nodeId))
  }

  // 4) Features e tasks (tasks com parentFeatureIndex penduram na feature).
  const itemRefs: IssueRef[] = []
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i]!
    const parent =
      item.kind === 'task' && item.parentFeatureIndex !== undefined
        ? itemRefs[item.parentFeatureIndex]!
        : epicRefs[item.epicIndex]!
    const marker = `gitorch:node:${plan.wish.number}:item:${i}`
    const blocked = (item.blockedByItemIndexes ?? [])
      .map((b) => itemRefs[b]?.number)
      .filter((n): n is number => typeof n === 'number')
    const blockedLine =
      blocked.length > 0 ? `\n\nBlocked by ${blocked.map((n) => `#${n}`).join(', ')}` : ''
    const ref = await ensureNode(
      marker,
      item.fields.titulo,
      renderIssueBody(item.fields, marker) + blockedLine,
      parent.nodeId
    )
    itemRefs.push(ref)
    boardItemByNode.set(ref.nodeId, await github.addToBoard(ref.nodeId))
  }

  // 5) Sprint Goal visível no board (status update) — o board é a interface.
  if (plan.sprint?.sprintGoal && github.postSprintGoal) {
    await github.postSprintGoal(plan.sprint.sprintGoal)
  }

  // 5b) Sprint: seta a iteração nos selecionados.
  const selected = new Set(plan.sprint?.selectedItemIndexes ?? [])
  for (const index of selected) {
    const ref = itemRefs[index]
    if (!ref) continue
    const boardItem = boardItemByNode.get(ref.nodeId)
    if (boardItem) await github.setSprint(boardItem)
  }

  // 6) Delegação: tasks selecionadas SEM dependência aberta ganham a label.
  if (options.delegateLabel) {
    for (const index of selected) {
      const item = plan.items[index]
      const ref = itemRefs[index]
      if (!item || !ref) continue
      const isBlocked = (item.blockedByItemIndexes ?? []).length > 0
      if (item.kind === 'task' && !isBlocked) {
        await github.addLabels(ref.nodeId, [options.delegateLabel])
      }
    }
  }

  return result
}
