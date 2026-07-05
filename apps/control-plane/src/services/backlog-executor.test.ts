import { describe, it, expect } from 'vitest'
import {
  applyBacklog,
  renderIssueBody,
  type BacklogGitHub,
  type BacklogPlan,
} from './backlog-executor.js'
import type { DoDFields } from '@gitorch/cadence'

function fields(over: Partial<DoDFields> = {}): DoDFields {
  return {
    titulo: '[Task] t',
    description: 'd',
    notes: 'n',
    implementationGuide: '1. a; 2. b; 3. c',
    verificationCriteria: '- resposta filtrada por material\n- teste de API verde',
    summary: 's',
    analysisResult: 'a',
    relatedFiles: 'x.ts',
    ...over,
  }
}

function plan(): BacklogPlan {
  return {
    wish: { issueNumber: 100, nodeId: 'I_wish' },
    phases: [{ title: 'Fase 1 — Dados', goal: 'estruturar', rationale: 'base' }],
    epics: [{ phaseIndex: 0, title: 'Épico: coluna material', description: 'desc' }],
    items: [
      { epicIndex: 0, kind: 'feature', fields: fields({ titulo: '[Feature] filtro' }) },
      { epicIndex: 0, kind: 'task', parentFeatureIndex: 0, fields: fields() },
    ],
    sprint: { sprintGoal: 'Filtrar por material', selectedItemIndexes: [1] },
  }
}

function fakeGitHub(existingMarkers: string[] = []) {
  const created: Array<{ title: string; body: string; labels?: string[] }> = []
  const subIssues: Array<{ parent: string; child: string }> = []
  const boardAdds: string[] = []
  const iterations: string[] = []
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
    async setSprint(itemId) {
      iterations.push(itemId)
    },
    async addLabels() {},
  }
  return { gh, created, subIssues, boardAdds, iterations }
}

describe('renderIssueBody', () => {
  it('corpo tem os 8 campos na ordem canônica + marker de idempotência', () => {
    const body = renderIssueBody(fields(), 'gitorch:node:abc')
    const idx = [
      'Título',
      'Description',
      'Notes',
      'Implementation Guide',
      'Verification Criteria',
      'Summary',
      'Analysis Result',
      'Related Files',
    ].map((h) => body.indexOf(`## ${h}`))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(body).toContain('<!-- gitorch:node:abc -->')
  })
})

describe('applyBacklog', () => {
  it('valida DoD de TODOS os itens ANTES de criar qualquer coisa (all-or-nothing)', async () => {
    const { gh, created } = fakeGitHub()
    const bad = plan()
    bad.items[1] = { ...bad.items[1], fields: fields({ verificationCriteria: ' ' }) }

    await expect(applyBacklog({ github: gh, plan: bad })).rejects.toThrow(/verificationCriteria/)
    expect(created).toHaveLength(0)
  })

  it('monta a árvore wish→fase→épico→feature→task, board e sprint', async () => {
    const { gh, created, subIssues, boardAdds, iterations } = fakeGitHub()
    const result = await applyBacklog({ github: gh, plan: plan() })

    // criados: 1 fase + 1 épico + 2 itens = 4 issues
    expect(created).toHaveLength(4)
    // árvore: fase sob wish; épico sob fase; feature sob épico; task sob feature
    expect(subIssues[0].parent).toBe('I_wish')
    expect(subIssues).toHaveLength(4)
    // todos entram no board
    expect(boardAdds).toHaveLength(4)
    // sprint setada só no item selecionado (a task)
    expect(iterations).toHaveLength(1)
    expect(result.createdCount).toBe(4)
  })

  it('idempotente: nó com marker existente NÃO é recriado', async () => {
    const p = plan()
    // marker determinístico da fase 0
    const { gh, created } = fakeGitHub(['gitorch:node:100:phase:0'])
    const result = await applyBacklog({ github: gh, plan: p })
    // fase pulada; épico + 2 itens criados
    expect(created.map((c) => c.title)).not.toContain('Fase 1 — Dados')
    expect(created).toHaveLength(3)
    expect(result.skippedCount).toBe(1)
  })

  it('delega: tasks selecionadas na sprint E sem dependência recebem label jules', async () => {
    const labeled: Array<{ nodeId: string; labels: string[] }> = []
    const { gh } = fakeGitHub()
    gh.addLabels = async (nodeId, labels) => {
      labeled.push({ nodeId, labels })
    }
    await applyBacklog({ github: gh, plan: plan(), delegateLabel: 'jules' })
    expect(labeled).toHaveLength(1)
    expect(labeled[0].labels).toContain('jules')
  })
})
