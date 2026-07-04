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

  test('RA: codegraph primeiro, cruft é achado de limpeza, não cria tasks', () => {
    const ra = loadPlaybook('ra')
    expect(ra).toMatch(/code graph/i)
    expect(ra).toMatch(/cleanup finding/i)
    expect(ra).toMatch(/do NOT create epics, features,\s+or tasks/i)
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

  test('SM: valida DoD, delega por label jules ou humano, não delega fora do padrão', () => {
    const sm = loadPlaybook('sm')
    expect(sm).toMatch(/jules/i)
    expect(sm).toMatch(/assignee/i)
    expect(sm).toMatch(/do NOT delegate/i)
  })

  test('QA: Verification Criteria, CI verde obrigatório, itera com @jules', () => {
    const qa = loadPlaybook('qa')
    expect(qa).toMatch(/Verification Criteria/i)
    expect(qa).toMatch(/never approve.*CI/i)
    expect(qa).toContain('@jules')
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
      'Título',
      'Description',
      'Notes',
      'Implementation Guide',
      'Verification Criteria',
      'Summary',
      'Analysis Result',
      'Related Files',
    ])
  })

  test('versão presente (semver)', () => {
    expect(CADENCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
