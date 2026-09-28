import { buildAgentMission, resumeMissionFromCheckpoint } from './agent-mission'
import { buildAgentMission as exportedBuildAgentMission } from './index'
import type { MissionState, RuntimeCredentialRef, StateNode, NodeTransition } from './types'
import { vi } from 'vitest'

const mockHydrateStateFromCheckpoint = vi.hoisted(() => vi.fn())

vi.mock('./workspace-priming.js', () => ({
  hydrateStateFromCheckpoint: mockHydrateStateFromCheckpoint,
  primeWorkspace: vi.fn(),
}))

test('builds a PO mission with default runtime and credential reference', () => {
  const mission = buildAgentMission({
    id: 'mission-po-1',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Normalize externally created issue #42',
    context: ['GitHub is the source of truth', 'Classify issue as Epic, Feature, or Task'],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: [],
    },
  })

  expect(mission.runtime).toEqual({ runtime: 'codex' })
  expect(mission.prompt).toContain('Role: po')
  expect(mission.prompt).toContain('Repository: owner/repo')
  expect(mission.prompt).toContain('Normalize externally created issue #42')
  expect(mission.prompt).toContain('GitHub is the source of truth')
})

test('rejects credential/runtime mismatch before execution', () => {
  expect(() =>
    buildAgentMission({
      id: 'mission-ra-1',
      projectId: 'project-1',
      repository: 'owner/repo',
      role: 'ra',
      goal: 'Read project docs',
      context: [],
      credentialRef: {
        connectionId: 'conn-claude',
        ownerScope: 'organization',
        runtime: 'claude',
        providedSecrets: ['ANTHROPIC_API_KEY'],
      },
    })
  ).toThrow('Credential runtime claude does not match selected runtime codex')
})

test('defaults evidence refs and supports matching explicit runtime override', () => {
  const mission = exportedBuildAgentMission({
    id: 'mission-ra-2',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'ra',
    goal: 'Summarize repository context',
    context: [],
    runtime: { runtime: 'codex', model: 'gpt-5', reasoning: 'high' },
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(mission.runtime).toEqual({ runtime: 'codex', model: 'gpt-5', reasoning: 'high' })
  expect(mission.evidenceRefs).toEqual([])
})

test('includes subPath context instructions in prompt when subPath is provided', () => {
  const mission = buildAgentMission({
    id: 'mission-subpath-1',
    projectId: 'project-1',
    repository: 'owner/multi-repo',
    repositoryKey: 'owner/backend',
    subPath: 'repos/backend',
    role: 'qa',
    goal: 'Add an API endpoint',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: [],
    },
  })

  expect(mission.repositoryKey).toBe('owner/backend')
  expect(mission.subPath).toBe('repos/backend')
  expect(mission.prompt).toContain(
    'Working Directory: You are working in a multi-repo workspace. Your target repository is located at /workspace/repos/backend'
  )
})

test('keeps credential reference immutable from caller mutations after mission creation', () => {
  const credentialRef: RuntimeCredentialRef = {
    connectionId: 'conn-codex',
    ownerScope: 'project',
    runtime: 'codex',
    providedSecrets: [],
  }

  const mission = buildAgentMission({
    id: 'mission-po-2',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Prepare project evidence',
    context: [],
    credentialRef,
  })

  credentialRef.providedSecrets.push('MUTATED_SECRET')
  credentialRef.runtime = 'claude'

  expect(mission.credentialRef).toEqual({
    connectionId: 'conn-codex',
    ownerScope: 'project',
    runtime: 'codex',
    providedSecrets: [],
  })
})

test('propagates userId to buildAgentMission output if provided', () => {
  const mission = buildAgentMission({
    id: 'mission-po-3',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Test user ID propagation',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: [],
    },
    userId: 'user-123',
  })

  expect(mission.userId).toBe('user-123')
})

test('resumeMissionFromCheckpoint updates state to resuming and executes from pendingRole', async () => {
  const mission = buildAgentMission({
    id: 'mission-resume-1',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Test resume mission',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: [],
    },
  })

  const currentState: MissionState = {
    mission,
    workspacePath: '/mock/workspace',
  }

  mockHydrateStateFromCheckpoint.mockResolvedValueOnce(JSON.stringify({ pendingRole: 'dev' }))

  const mockDevExecute = vi.fn().mockResolvedValue({
    nextRole: 'done',
    state: { ...currentState, mission: { ...currentState.mission, status: 'done' } },
  } as NodeTransition)

  const nodeRegistry = new Map<string, StateNode>([
    ['po', { role: 'po', execute: vi.fn() }],
    ['dev', { role: 'dev', execute: mockDevExecute }],
  ])

  const result = await resumeMissionFromCheckpoint(
    'mission-resume-1',
    '/mock/workspace',
    currentState,
    nodeRegistry
  )

  expect(mockHydrateStateFromCheckpoint).toHaveBeenCalledWith('/mock/workspace')
  expect(mockDevExecute).toHaveBeenCalled()

  // Dev node was called with the 'resuming' state
  const devExecuteCallArgs = mockDevExecute.mock.calls[0][0] as MissionState
  expect(devExecuteCallArgs.mission.status).toBe('resuming')

  expect(result.mission.status).toBe('done')
})
