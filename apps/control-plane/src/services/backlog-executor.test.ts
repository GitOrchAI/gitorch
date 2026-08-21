import { describe, it, expect } from 'vitest'
import {
  applyBacklog,
  renderIssueBody,
  validateBacklogPlan,
  type BacklogGitHub,
  type BacklogPlan,
} from './backlog-executor.js'
import { agentLabel } from './agent-label.js'
import type { DoDFields } from '@gitorch/cadence'

function fields(over: Partial<DoDFields> = {}): DoDFields {
  return {
    titulo: '[Task] t',
    goal: 'g',
    taskDetails: 'td',
    taskDescription: 'd',
    implementationGuide: '1. a; 2. b; 3. c',
    verificationCriteria: '- resposta filtrada por material\n- teste de API verde',
    dependencies: 'nenhuma',
    relatedFiles: 'x.ts',
    notes: 'n',
    ...over,
  }
}

/** Plano válido mínimo: 1 fase → 1 épico (cobre 2 jornadas) → 1 feature → 2 tasks. */
function plan(): BacklogPlan {
  return {
    wish: { number: 100, nodeId: 'I_wish' },
    journeysCount: 2,
    phases: [{ title: 'Fase 1 — Dados', goal: 'estruturar', rationale: 'base' }],
    epics: [
      {
        phaseIndex: 0,
        title: 'Épico: coluna material',
        description: 'desc',
        journeyIndexes: [0, 1],
      },
    ],
    features: [{ epicIndex: 0, title: '[Feature] filtro', description: 'filtro por material' }],
    tasks: [
      { featureIndex: 0, fields: fields({ titulo: '[Task] schema' }) },
      { featureIndex: 0, fields: fields(), blockedByTaskIndexes: [0] },
    ],
    roadmap: {
      sprintGoal: 'Filtrar por material',
      assignments: [
        { taskIndex: 0, sprint: 1 },
        { taskIndex: 1, sprint: 2 },
      ],
    },
  }
}

function fakeGitHub(existingMarkers: string[] = []) {
  const created: Array<{ title: string; body: string; labels?: string[] }> = []
  const subIssues: Array<{ parent: string; child: string }> = []
  const boardAdds: string[] = []
  const iterations: Array<{ itemId: string; sprint: number }> = []
  const milestones: Array<{ issue: number; sprint: number }> = []
  const statuses: Array<{ boardItemId: string; column: string }> = []
  const labels: Array<{ nodeId: string; labels: string[] }> = []
  let n = 200
  const gh: BacklogGitHub = {
    async findIssueByMarker(marker) {
      return existingMarkers.includes(marker) ? { number: 999, nodeId: `I_exist_${marker}` } : null
    },
    async createIssue(input) {
      created.push(input)
      n += 1
      return { number: n, nodeId: `I_${n}` }
    },
    async addSubIssue(parentNodeId, childNodeId) {
      subIssues.push({ parent: parentNodeId, child: childNodeId })
    },
    async addToBoard(nodeId) {
      boardAdds.push(nodeId)
      return `PVTI_${nodeId}`
    },
    async setSprint(itemId, sprint) {
      iterations.push({ itemId, sprint })
    },
    async addLabels(nodeId, ls) {
      labels.push({ nodeId, labels: ls })
    },
    async setStatus(boardItemId, column) {
      statuses.push({ boardItemId, column })
    },
    async setMilestone(issue, sprint) {
      milestones.push({ issue, sprint })
    },
  }
  return { gh, created, subIssues, boardAdds, iterations, milestones, statuses, labels }
}

describe('renderIssueBody', () => {
  it('corpo tem os 8 campos do padrão Shrimp na ordem canônica + marker de idempotência', () => {
    const body = renderIssueBody(fields(), 'gitorch:node:abc')
    const idx = [
      'Goal',
      'Task Details',
      'Task Description',
      'Implementation Guide',
      'Verification Criteria',
      'Dependencies',
      'Related Files',
      'Notes',
    ].map((h) => body.indexOf(`## ${h}`))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(body).toContain('<!-- gitorch:node:abc -->')
  })
})

describe('validateBacklogPlan', () => {
  it('plano válido passa sem problemas', () => {
    expect(validateBacklogPlan(plan())).toEqual([])
  })

  it('jornada do RA ignorada pelos épicos → rejeitado (o "plano raso")', () => {
    const p = plan()
    p.epics[0]!.journeyIndexes = [0] // jornada 1 fica descoberta
    expect(validateBacklogPlan(p).join(' ')).toContain('journey 1 is not covered')
  })

  it('épico sem feature e feature sem task → rejeitados', () => {
    const semFeature = plan()
    semFeature.epics.push({
      phaseIndex: 0,
      title: 'Épico órfão',
      description: 'x',
      journeyIndexes: [0],
    })
    expect(validateBacklogPlan(semFeature).join(' ')).toContain('epics[1]: has no feature')

    const semTask = plan()
    semTask.features.push({ epicIndex: 0, title: '[Feature] vazia', description: 'x' })
    expect(validateBacklogPlan(semTask).join(' ')).toContain('features[1]: has no task')
  })

  it('roadmap: task sem sprint e dependência de sprint futura → rejeitados', () => {
    const semSprint = plan()
    semSprint.roadmap.assignments = [{ taskIndex: 0, sprint: 1 }]
    expect(validateBacklogPlan(semSprint).join(' ')).toContain('task 1 has no sprint')

    const invertido = plan()
    // task 1 depende da task 0, mas task 0 cai na sprint 3 e task 1 na 1
    invertido.roadmap.assignments = [
      { taskIndex: 0, sprint: 3 },
      { taskIndex: 1, sprint: 1 },
    ]
    expect(validateBacklogPlan(invertido).join(' ')).toContain('depends on task 0 (sprint 3)')
  })
})

describe('applyBacklog', () => {
  it('valida DoD de TODAS as tasks ANTES de criar qualquer coisa (all-or-nothing)', async () => {
    const { gh, created } = fakeGitHub()
    const bad = plan()
    bad.tasks[1] = { featureIndex: 0, fields: fields({ verificationCriteria: ' ' }) }

    await expect(applyBacklog({ github: gh, plan: bad })).rejects.toThrow(/verificationCriteria/)
    expect(created).toHaveLength(0)
  })

  it('monta a árvore wish→fase→épico→feature→task com board, status e roadmap', async () => {
    const { gh, created, subIssues, boardAdds, iterations, milestones, statuses } = fakeGitHub()
    const result = await applyBacklog({ github: gh, plan: plan() })

    // 1 fase + 1 épico + 1 feature + 2 tasks = 5 issues, todas no board com status
    expect(created).toHaveLength(5)
    expect(result.createdCount).toBe(5)
    expect(boardAdds).toHaveLength(5)
    expect(statuses.every((s) => s.column === 'todo')).toBe(true)

    // árvore: fase sob wish, épico sob fase, feature sob épico, tasks sob feature
    expect(subIssues[0]!.parent).toBe('I_wish')
    expect(subIssues).toHaveLength(5)

    // roadmap: cada task com sua sprint na iteração E no milestone datado
    expect(iterations).toEqual([
      { itemId: 'PVTI_I_204', sprint: 1 },
      { itemId: 'PVTI_I_205', sprint: 2 },
    ])
    expect(milestones).toEqual([
      { issue: 204, sprint: 1 },
      { issue: 205, sprint: 2 },
    ])
    expect(result.sprintsPlanned).toBe(2)

    // épico publica quais jornadas cobre (visível ao cliente)
    const epicBody = created[1]!.body
    expect(epicBody).toContain('Covers journeys')
  })

  it('task com blocker publica "Blocked by"; tasks nascem com a label de tipo p/ delegação contínua do SM', async () => {
    // Antes: este teste também afirmava que o PO delegava (labels via
    // addLabels). Decisão do dono (14/08/2026) tirou isso do PO — quem decide
    // delegar agora é só o SM (sm-delegation.ts), então as asserções de
    // delegação saíram daqui e viraram o teste "não aplica a etiqueta de
    // delegação" logo abaixo.
    const { gh, created } = fakeGitHub()
    await applyBacklog({ github: gh, plan: plan() })

    const task2 = created[4]!
    expect(task2.body).toContain('Blocked by #204')
    // tasks nascem com a label de tipo p/ delegação contínua do SM
    expect(created[3]!.labels).toContain('gitorch:task')
  })

  it('toda issue nova nasce marcada como produção do PO (gitorch:agent:po)', async () => {
    const { gh, created } = fakeGitHub()
    await applyBacklog({ github: gh, plan: plan() })

    // fase, épico, feature e as 2 tasks — os 5 nós que o PO produziu.
    expect(created).toHaveLength(5)
    expect(created.every((c) => (c.labels ?? []).includes(agentLabel('po')))).toBe(true)
    // a task continua carregando a label de TIPO, que o SM usa para achá-la.
    expect(created[3]!.labels).toContain('gitorch:task')
  })

  it('idempotência: marker existente reusa a issue (não duplica)', async () => {
    const { gh, created } = fakeGitHub(['gitorch:node:100:phase:0'])
    const result = await applyBacklog({ github: gh, plan: plan() })
    expect(result.skippedCount).toBe(1)
    expect(created).toHaveLength(4)
  })

  it('Sprint Goal publicado com o tamanho do roadmap', async () => {
    const { gh } = fakeGitHub()
    const goals: string[] = []
    gh.postSprintGoal = async (goal) => {
      goals.push(goal)
    }
    await applyBacklog({ github: gh, plan: plan() })
    expect(goals[0]).toContain('Filtrar por material')
    expect(goals[0]).toContain('Sprint 1 of 2 planned')
  })

  it('não aplica a etiqueta de delegação — quem delega é o SM', async () => {
    // Decisão do dono (14/08/2026): só o SM delega (sm-delegation.ts). Mesmo
    // recebendo delegateLabel, o PO monta o plano e para.
    const { gh, created, labels } = fakeGitHub()
    await applyBacklog({ github: gh, plan: plan(), delegateLabel: 'jules' })

    // toda label enviada por qualquer caminho: nascimento da issue (createIssue)
    // e chamada avulsa (addLabels) — 'jules' não pode aparecer em nenhum dos dois.
    const labelsAplicadas = [
      ...created.flatMap((c) => c.labels ?? []),
      ...labels.flatMap((l) => l.labels),
    ]
    expect(labelsAplicadas).not.toContain('jules')
    expect(labelsAplicadas).toContain('gitorch:task')
  })
})
