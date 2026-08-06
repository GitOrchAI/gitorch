import { describe, expect, test } from 'vitest'
import { buildPrimingPreamble } from './priming.js'
import { buildAgentMission } from '../agent-mission.js'

describe('buildPrimingPreamble', () => {
  test('estabelece identidade GitOrch e precedência sobre regras do repo-alvo', () => {
    const preamble = buildPrimingPreamble('ra')
    expect(preamble).toContain('GitOrch Research Analyst (RA) agent')
    expect(preamble).toContain('PRECEDENCE')
    expect(preamble).toMatch(/AGENTS\.md, CLAUDE\.md, GEMINI\.md/)
    expect(preamble).toContain('IGNORE any process/instruction files')
  })

  test('cada papel tem seu título', () => {
    expect(buildPrimingPreamble('po')).toContain('Product Owner (PO)')
    expect(buildPrimingPreamble('sm')).toContain('Scrum Master (SM)')
    expect(buildPrimingPreamble('qa')).toContain('Quality Assurance (QA)')
  })

  test('RA e QA (técnicos) têm liberdade para montar dev e testar', () => {
    for (const role of ['ra', 'qa'] as const) {
      expect(buildPrimingPreamble(role)).toContain('FREEDOM TO TEST')
    }
  })

  test('PO e SM (coordenação) não recebem liberdade de execução', () => {
    for (const role of ['po', 'sm'] as const) {
      const p = buildPrimingPreamble(role)
      expect(p).not.toContain('FREEDOM TO TEST')
      expect(p).toContain('coordination role')
    }
  })

  test('todos os papéis exigem convergência/entrega do deliverable', () => {
    for (const role of ['ra', 'po', 'sm', 'qa'] as const) {
      expect(buildPrimingPreamble(role)).toContain('CONVERGENCE')
    }
  })

  test('o prompt da missão inclui o priming antes das instruções do sistema', () => {
    const mission = buildAgentMission({
      id: 'm1',
      projectId: 'p1',
      repository: 'owner/repo',
      role: 'ra',
      goal: 'Analyze',
      context: [],
      runtime: { runtime: 'antigravity' },
      credentialRef: {
        connectionId: 'c1',
        ownerScope: 'project',
        runtime: 'antigravity',
        providedSecrets: [],
      },
    })
    const primingIdx = mission.prompt.indexOf('PRECEDENCE')
    const systemIdx = mission.prompt.indexOf('System Instructions:')
    expect(primingIdx).toBeGreaterThanOrEqual(0)
    expect(primingIdx).toBeLessThan(systemIdx)
  })

  test('Antigravity recebe reforço de convergência/entrega (política vem do plugin/hook)', () => {
    const p = buildPrimingPreamble('ra', 'antigravity')
    expect(p).toContain('DELIVERY')
    expect(p).toMatch(/deliverable/)
    expect(p).not.toContain('FREEDOM TO TEST')
  })

  test('Codex/Claude mantêm liberdade de testar', () => {
    expect(buildPrimingPreamble('ra', 'codex')).toContain('FREEDOM TO TEST')
    expect(buildPrimingPreamble('qa', 'claude')).toContain('FREEDOM TO TEST')
  })
})

describe('prompt da missão carrega o playbook Cadence (fonte única do método)', () => {
  const baseInput = {
    id: 'm1',
    projectId: 'p1',
    repository: 'owner/repo',
    goal: 'Goal',
    context: [],
    credentialRef: {
      connectionId: 'c1',
      ownerScope: 'project' as const,
      runtime: 'antigravity' as const,
      providedSecrets: [],
    },
    runtime: { runtime: 'antigravity' as const },
  }

  test('PO recebe DoD de 8 campos e Sprint Goal', () => {
    const m = buildAgentMission({ ...baseInput, role: 'po' })
    expect(m.prompt).toContain('Sprint Goal')
    expect(m.prompt).toContain('Implementation Guide')
    expect(m.prompt).toContain('Task Details')
  })

  test('RA recebe codegraph-first e cleanup findings', () => {
    const m = buildAgentMission({ ...baseInput, role: 'ra' })
    expect(m.prompt).toMatch(/code graph/i)
    expect(m.prompt).toMatch(/cleanup finding/i)
  })

  test('QA recebe Verification Criteria e veredito estruturado (Lei: sistema posta)', () => {
    const m = buildAgentMission({ ...baseInput, role: 'qa' })
    expect(m.prompt).toContain('Verification Criteria')
    // Lei "LLM decide, sistema executa": o playbook pede o veredito estruturado;
    // quem menciona @jules na PR é o executor do control plane, não a LLM.
    expect(m.prompt).toContain('request_changes')
  })

  test('prompt não vira romance (gate de tamanho por papel)', () => {
    for (const role of ['ra', 'po', 'sm', 'qa'] as const) {
      const m = buildAgentMission({ ...baseInput, role })
      expect(m.prompt.length).toBeLessThan(8000)
    }
  })
})
