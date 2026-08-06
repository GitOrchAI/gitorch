import { describe, expect, test } from 'vitest'
import { CADENCE_VERSION, ISSUE_DOD_FIELDS, loadEventPlaybook, loadPlaybook } from './index.js'

// O Cadence é a fonte única do MÉTODO dos agentes. Estes testes travam a
// estrutura mínima que o produto depende: se um playbook perder uma âncora
// (ex.: o PO sem o DoD de 8 campos), o build quebra aqui, não em produção.

describe('playbooks por papel', () => {
  test('todos existem e não são vazios', () => {
    for (const role of ['ra', 'po', 'sm', 'qa'] as const) {
      const text = loadPlaybook(role)
      expect(text.length).toBeGreaterThan(400)
    }
  })

  test('RA: tech scout, codegraph primeiro, cruft é achado, propõe melhoria, não cria tasks', () => {
    const ra = loadPlaybook('ra')
    expect(ra).toMatch(/technical scout|tech lead/i)
    expect(ra).toMatch(/code graph/i)
    expect(ra).toMatch(/cleanup finding/i)
    expect(ra).toMatch(/improvement/i)
    expect(ra).toMatch(/do NOT create[\s\S]*tasks/i)
    // Lei: nenhum tooling de ação no playbook.
    expect(ra).not.toMatch(/`gh`|gh api|MCP/)
  })

  test('PO: hierarquia, DoD de 8 campos, dependências e Sprint Goal', () => {
    const po = loadPlaybook('po')
    expect(po).toMatch(/Epic\s*→\s*Feature\s*→\s*Task/i)
    for (const field of ISSUE_DOD_FIELDS) {
      expect(po).toContain(field)
    }
    expect(po).toMatch(/blocked by/i)
    expect(po).toMatch(/Sprint Goal/i)
  })

  test('SM: DoD mecânico é do código; delega jules/humano só desbloqueado', () => {
    const sm = loadPlaybook('sm')
    expect(sm).toMatch(/jules/i)
    expect(sm).toMatch(/assignee/i)
    // Lei: a conferência mecânica do DoD saiu do SM (é código do executor).
    expect(sm).toMatch(/BY GITORCH CODE/i)
    expect(sm).toMatch(/UNBLOCKED/i)
    expect(sm).not.toMatch(/`gh`|gh api/)
  })

  test('QA: Verification Criteria, CI verde obrigatório, veredito estruturado', () => {
    const qa = loadPlaybook('qa')
    expect(qa).toMatch(/Verification Criteria/i)
    expect(qa).toMatch(/never approve when CI/i)
    expect(qa).toMatch(/request_changes/)
    expect(qa).toMatch(/cannot verify/i)
    expect(qa).not.toMatch(/`gh`|gh api/)
  })
})

describe('playbooks de eventos SCRUM', () => {
  test('todos existem e não são vazios', () => {
    for (const event of ['sprint-planning', 'daily', 'sprint-review', 'sprint-retro'] as const) {
      expect(loadEventPlaybook(event).length).toBeGreaterThan(200)
    }
  })

  test('planning define Sprint Goal; retro produz melhoria acionável', () => {
    expect(loadEventPlaybook('sprint-planning')).toMatch(/Sprint Goal/i)
    expect(loadEventPlaybook('sprint-retro')).toMatch(/improvement/i)
  })
})

describe('constantes', () => {
  test('DoD tem exatamente os 8 campos canônicos, na ordem', () => {
    expect(ISSUE_DOD_FIELDS).toEqual([
      'Goal',
      'Task Details',
      'Task Description',
      'Implementation Guide',
      'Verification Criteria',
      'Dependencies',
      'Related Files',
      'Notes',
    ])
  })

  test('versão presente (semver)', () => {
    expect(CADENCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
