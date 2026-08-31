import { describe, it, expect } from 'vitest'
import {
  applyBacklog,
  renderIssueBody,
  validateBacklogPlan,
  type BacklogGitHub,
  type BacklogPlan,
  type IssueRef,
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
    phases: [
      {
        title: 'Fase 1 — Dados',
        goal: 'estruturar',
        rationale: 'base',
        usableOutcome: 'O dono filtra os produtos por material e vê o resultado certo.',
      },
    ],
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
      {
        featureIndex: 0,
        fields: fields({ titulo: '[Task] schema' }),
        weight: 3,
        weightRationale: 'Uma coluna nova e um filtro; o padrão já existe no schema.',
      },
      {
        featureIndex: 0,
        fields: fields(),
        blockedByTaskIndexes: [0],
        weight: 8,
        weightRationale: 'Toca duas telas e a rota; a incerteza está no cache.',
      },
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
  /** nodeId devolvido para cada `created[i]` — liga issue → card do quadro. */
  const refs: IssueRef[] = []
  /** Estado do QUADRO: peso gravado por item. Conferimos o ESTADO, não a chamada. */
  const pesoDoItem = new Map<string, number>()
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
      const ref = { number: n, nodeId: `I_${n}` }
      refs.push(ref)
      return ref
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
    async setWeight(boardItemId, weight) {
      pesoDoItem.set(boardItemId, weight)
    },
  }
  return {
    gh,
    created,
    refs,
    pesoDoItem,
    subIssues,
    boardAdds,
    iterations,
    milestones,
    statuses,
    labels,
  }
}

describe('renderIssueBody', () => {
  it('corpo tem os 8 campos do padrão Shrimp na ordem canônica + marker de idempotência', () => {
    const body = renderIssueBody(fields(), 'gitorch:node:abc', null)
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

  // L3-T8: `weight` e `weightRationale` são EXIGIDOS do modelo (schema
  // `poTasks`, escala 1,2,3,5,8,13) e até 31/08/2026 só serviam para balancear
  // sprint — nunca chegavam ao GitHub. O dono: "as issues são rasas... quando
  // é P2, quando é P0? não vejo visualmente no GitHub". Este teste olha o
  // CORPO GERADO: peso E o porquê dele, ANTES do Goal (é o primeiro sinal de
  // tamanho que ele lê).
  it('corpo publica o peso E o porquê dele, ANTES do Goal', () => {
    const body = renderIssueBody(fields(), 'gitorch:node:abc', {
      weight: 8,
      rationale: 'Toca duas telas e a rota; a incerteza está no cache.',
    })

    expect(body).toContain('## Peso')
    expect(body).toContain('8')
    expect(body).toContain('Toca duas telas e a rota; a incerteza está no cache.')

    const iPeso = body.indexOf('## Peso')
    const iGoal = body.indexOf('## Goal')
    expect(iPeso).toBeGreaterThan(-1)
    expect(iPeso).toBeLessThan(iGoal)
  })

  // A issue de CONSERTO (conserto-de-publicacao.ts) e a do sensor de infra
  // (scheduler.ts) nascem sem peso — não vieram do roteiro do PO. Inventar um
  // número ali seria mentir sobre estimativa que ninguém fez.
  it('sem peso, nenhuma seção de peso aparece — não inventa número', () => {
    const body = renderIssueBody(fields(), 'gitorch:node:abc', null)
    expect(body).not.toContain('## Peso')
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

  // L3-T8. `PESO_MAXIMO_DE_SPRINT` existia desde sempre, documentado como
  // "Acima de 13 não entra", e NENHUM código o consultava: o único teste que o
  // citava conferia que a constante vale 13. O teto virou regra aqui, no mesmo
  // portão que já rejeita plano raso — e rejeitar o PLANO é o que faz a task
  // grande demais não entrar em sprint nenhuma, em vez de entrar e travar.
  it('peso acima do teto (13) derruba o plano — a task não entra em sprint', () => {
    const gigante = plan()
    gigante.tasks[0]!.weight = 21 as never

    const problemas = validateBacklogPlan(gigante)
    expect(problemas.join(' ')).toContain('tasks[0]')
    expect(problemas.join(' ')).toContain('21')
    expect(problemas.join(' ')).toContain('13')
  })

  it('peso 13 é o limite e PASSA — o teto é inclusivo, não "quase"', () => {
    const noLimite = plan()
    noLimite.tasks[0]!.weight = 13
    expect(validateBacklogPlan(noLimite)).toEqual([])
  })

  it('peso fora da escala (4) é rejeitado — os buracos da escala são de propósito', () => {
    const foraDaEscala = plan()
    foraDaEscala.tasks[0]!.weight = 4 as never
    expect(validateBacklogPlan(foraDaEscala).join(' ')).toContain('tasks[0]')
  })
})

describe('applyBacklog', () => {
  // L3-T8: o plano com uma task pesada demais não pode criar NADA — o portão
  // é all-or-nothing, igual ao do DoD.
  it('plano com task acima do teto de peso não cria issue nenhuma', async () => {
    const { gh, created } = fakeGitHub()
    const gigante = plan()
    gigante.tasks[1]!.weight = 21 as never

    await expect(applyBacklog({ github: gh, plan: gigante })).rejects.toThrow(/13/)
    expect(created).toEqual([])
  })

  it('valida DoD de TODAS as tasks ANTES de criar qualquer coisa (all-or-nothing)', async () => {
    const { gh, created } = fakeGitHub()
    const bad = plan()
    bad.tasks[1] = {
      featureIndex: 0,
      fields: fields({ verificationCriteria: ' ' }),
      weight: 2,
      weightRationale: 'pequena',
    }

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

  // L3-T7: a raiz da "issue rasa". O `usableOutcome` é EXIGIDO do modelo no
  // schema poPhases e era descartado antes de virar issue — a issue de fase
  // saía só com Goal e Rationale (prova ao vivo: issue #299). Este teste olha
  // o CORPO GERADO, não a chamada: se a frase do resultado usável não estiver
  // impressa, e impressa ANTES do Goal (é a primeira linha que o dono lê),
  // ele falha.
  it('corpo da fase publica o resultado usável do cliente, ANTES do Goal', async () => {
    const { gh, created } = fakeGitHub()
    const p = plan()
    p.phases[0]!.usableOutcome = 'O dono filtra os produtos por material e vê o resultado certo.'
    await applyBacklog({ github: gh, plan: p })

    const phaseBody = created[0]!.body
    expect(phaseBody).toContain('O dono filtra os produtos por material e vê o resultado certo.')

    const iOutcome = phaseBody.indexOf('O dono filtra os produtos por material')
    const iGoal = phaseBody.indexOf('**Goal**')
    const iRationale = phaseBody.indexOf('**Rationale**')
    expect(iOutcome).toBeGreaterThan(-1)
    expect(iOutcome).toBeLessThan(iGoal)
    expect(iGoal).toBeLessThan(iRationale)
  })

  // L3-T8: a outra metade da raiz da "issue rasa". O peso chegava ao
  // BacklogPlan (o roadmap já o usava para balancear sprint) e MORRIA ali: o
  // tipo `BacklogPlan['tasks']` não o declarava e a issue nascia sem tamanho
  // nenhum. Prova ao vivo do defeito: `gh issue view 311 -R GitOrchAI/gitorch`.
  // Este teste olha o CORPO GERADO da task, não a chamada.
  it('corpo da task publica o peso e o porquê dele', async () => {
    const { gh, created } = fakeGitHub()
    await applyBacklog({ github: gh, plan: plan() })

    const corpoDaTask = created.find((c) => c.title === '[Task] schema')!.body
    expect(corpoDaTask).toContain('## Peso')
    expect(corpoDaTask).toContain('3')
    expect(corpoDaTask).toContain('Uma coluna nova e um filtro; o padrão já existe no schema.')

    // A OUTRA task tem outro peso: um corpo montado com o peso fixo (ou com o
    // da task errada) passaria no teste de cima e reprova aqui.
    const corpoDaOutra = created.find((c) => c.title === '[Task] t')!.body
    expect(corpoDaOutra).toContain('Toca duas telas e a rota; a incerteza está no cache.')
  })

  // O dono: "não vejo visualmente no GitHub". Corpo de issue é texto; o que
  // ele olha de relance é o QUADRO. O peso tem que virar valor do campo do
  // card — e no card da TASK, que é a única unidade estimada.
  it('o card da task no quadro fica com o peso; fase/épico/feature NÃO', async () => {
    const { gh, created, refs, pesoDoItem } = fakeGitHub()
    await applyBacklog({ github: gh, plan: plan() })

    const itemDe = (titulo: string): string => {
      const i = created.findIndex((c) => c.title === titulo)
      return `PVTI_${refs[i]!.nodeId}`
    }

    // Estado final do quadro, item por item — não "foi chamado com".
    expect(pesoDoItem.get(itemDe('[Task] schema'))).toBe(3)
    expect(pesoDoItem.get(itemDe('[Task] t'))).toBe(8)
    // Fase, épico e feature são checkpoints: somam os filhos, não têm peso
    // próprio. Marcá-los com peso duplicaria a conta do quadro.
    expect(pesoDoItem.has(itemDe('Fase 1 — Dados'))).toBe(false)
    expect(pesoDoItem.has(itemDe('Épico: coluna material'))).toBe(false)
    expect(pesoDoItem.has(itemDe('[Feature] filtro'))).toBe(false)
    expect(pesoDoItem.size).toBe(2)
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
