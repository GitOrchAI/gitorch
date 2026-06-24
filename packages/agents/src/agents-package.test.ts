import {
  DEFAULT_AGENT_RUNTIME_ASSIGNMENTS,
  F6_AGENT_ROLES,
  F6_AGENT_RUNTIMES,
  type AgentMission,
  type AgentRuntimeAssignments,
  type AgentRuntimeSelection,
  type F6AgentRole,
  type F6AgentRuntime,
  type ReasoningEffort,
  type RuntimeCredentialRef,
} from './index'

test('exports F6 public contracts', () => {
  const role: F6AgentRole = 'qa'
  const runtime: F6AgentRuntime = 'antigravity'
  const reasoning: ReasoningEffort = 'high'
  const runtimeSelection: AgentRuntimeSelection = {
    runtime,
    model: 'Gemini 3.1 Pro High',
    reasoning,
  }
  const runtimeAssignments: AgentRuntimeAssignments = {
    po: { runtime: 'codex' },
    ra: { runtime: 'claude' },
    sm: { runtime: 'antigravity' },
    qa: runtimeSelection,
  }
  const credentialRef: RuntimeCredentialRef = {
    connectionId: 'conn-antigravity-1',
    ownerScope: 'project',
    runtime,
    providedSecrets: ['GOOGLE_APPLICATION_CREDENTIALS'],
  }
  const mission: AgentMission = {
    id: 'mission-qa-1',
    projectId: 'project-1',
    repository: 'owner/repo',
    role,
    goal: 'Verify delivered F6 scope',
    prompt: 'Run QA against the package contracts.',
    runtime: runtimeSelection,
    credentialRef,
    evidenceRefs: ['issue-1', 'pr-1'],
  }

  expect(role).toBe('qa')
  expect(runtime).toBe('antigravity')
  expect(reasoning).toBe('high')
  expect(runtimeSelection).toEqual({
    runtime: 'antigravity',
    model: 'Gemini 3.1 Pro High',
    reasoning: 'high',
  })
  expect(runtimeAssignments).toEqual({
    po: { runtime: 'codex' },
    ra: { runtime: 'claude' },
    sm: { runtime: 'antigravity' },
    qa: {
      runtime: 'antigravity',
      model: 'Gemini 3.1 Pro High',
      reasoning: 'high',
    },
  })
  expect(credentialRef).toEqual({
    connectionId: 'conn-antigravity-1',
    ownerScope: 'project',
    runtime: 'antigravity',
    providedSecrets: ['GOOGLE_APPLICATION_CREDENTIALS'],
  })
  expect(mission).toEqual({
    id: 'mission-qa-1',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'qa',
    goal: 'Verify delivered F6 scope',
    prompt: 'Run QA against the package contracts.',
    runtime: {
      runtime: 'antigravity',
      model: 'Gemini 3.1 Pro High',
      reasoning: 'high',
    },
    credentialRef: {
      connectionId: 'conn-antigravity-1',
      ownerScope: 'project',
      runtime: 'antigravity',
      providedSecrets: ['GOOGLE_APPLICATION_CREDENTIALS'],
    },
    evidenceRefs: ['issue-1', 'pr-1'],
  })
  expect(F6_AGENT_ROLES).toEqual(['po', 'ra', 'sm', 'qa'])
  expect(F6_AGENT_RUNTIMES).toEqual(['codex', 'claude', 'antigravity'])
  expect(DEFAULT_AGENT_RUNTIME_ASSIGNMENTS).toEqual({
    po: { runtime: 'codex' },
    ra: { runtime: 'claude' },
    sm: { runtime: 'antigravity' },
    qa: { runtime: 'antigravity' },
  })
})
