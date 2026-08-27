import {
  CANONICAL_RUNTIME_CHAIN,
  DEFAULT_AGENT_RUNTIME_ASSIGNMENTS,
  buildRuntimeChain,
  isF6AgentRole,
  isF6AgentRuntime,
  normalizeRuntimeAssignments,
} from './runtime-config'

test('uses user-approved MVP default runtime assignments', () => {
  expect(CANONICAL_RUNTIME_CHAIN).toEqual(['codex', 'antigravity', 'claude'])
  expect(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS).toEqual({
    po: { runtime: 'codex' },
    ra: { runtime: 'codex' },
    sm: { runtime: 'codex' },
    qa: { runtime: 'codex' },
  })
  expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS)).toBe(true)
  expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.po)).toBe(true)
  expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.ra)).toBe(true)
  expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.sm)).toBe(true)
  expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.qa)).toBe(true)
})

test('builds primary runtime plus fallback slots without mutating defaults', () => {
  const primary = {
    runtime: 'claude' as const,
    model: 'claude-opus-4-7',
    reasoning: 'high' as const,
  }
  const fallbacks = [
    { runtime: 'codex' as const, model: 'gpt-5.5', reasoning: 'medium' as const },
    { runtime: 'antigravity' as const, model: 'Gemini 3.1 Pro High', reasoning: 'high' as const },
  ]
  const chain = buildRuntimeChain(primary, fallbacks)

  expect(chain).toEqual([
    { runtime: 'claude', model: 'claude-opus-4-7', reasoning: 'high' },
    { runtime: 'codex', model: 'gpt-5.5', reasoning: 'medium' },
    { runtime: 'antigravity', model: 'Gemini 3.1 Pro High', reasoning: 'high' },
  ])
  expect(chain[0]).not.toBe(primary)
  expect(chain[1]).not.toBe(fallbacks[0])
  expect(chain[2]).not.toBe(fallbacks[1])

  chain[0].model = 'mutated-primary'
  chain[1].model = 'mutated-fallback'

  expect(primary).toEqual({ runtime: 'claude', model: 'claude-opus-4-7', reasoning: 'high' })
  expect(fallbacks[0]).toEqual({ runtime: 'codex', model: 'gpt-5.5', reasoning: 'medium' })
  expect(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.ra).toEqual({ runtime: 'codex' })
})

test('normalizes partial assignments over defaults', () => {
  const qaOverride = { runtime: 'claude' as const, model: 'claude-sonnet-4-6' }
  const assignments = normalizeRuntimeAssignments({
    qa: qaOverride,
  })

  expect(assignments).toEqual({
    po: { runtime: 'codex' },
    ra: { runtime: 'codex' },
    sm: { runtime: 'codex' },
    qa: { runtime: 'claude', model: 'claude-sonnet-4-6' },
  })
  expect(assignments.po).not.toBe(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.po)
  expect(assignments.qa).not.toBe(qaOverride)

  assignments.po.model = 'mutated-default-clone'
  assignments.qa.model = 'mutated-override-clone'

  expect(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.po).toEqual({ runtime: 'codex' })
  expect(qaOverride).toEqual({ runtime: 'claude', model: 'claude-sonnet-4-6' })
})

test('validates runtime and role names', () => {
  expect(isF6AgentRole('po')).toBe(true)
  expect(isF6AgentRole('dev')).toBe(false)
  expect(isF6AgentRuntime('codex')).toBe(true)
  expect(isF6AgentRuntime('jules')).toBe(false)
})
