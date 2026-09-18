import { vi } from 'vitest'
import {
  buildAgentMission,
  resumeMissionFromCheckpoint,
  workspaceManager,
  missionRegistry,
} from './agent-mission'
import { buildAgentMission as exportedBuildAgentMission } from './index'
import type { RuntimeCredentialRef } from './types'
import { orchestratorRegistry, AgentOrchestrator } from './orchestrator'
import * as workspacePriming from './workspace-priming'

vi.mock('./workspace-priming', () => ({
  hydrateStateFromCheckpoint: vi.fn(),
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

test('resumeMissionFromCheckpoint retrieves checkpoint, updates status to resuming, and re-sends execution', async () => {
  const missionId = 'mission-resume-1'
  const input = {
    id: missionId,
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po' as const,
    goal: 'Resume test',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project' as const,
      runtime: 'codex' as const,
      providedSecrets: [],
    },
    userId: 'user-123',
  }

  // Pre-seed registries
  missionRegistry.set(missionId, input)

  const fakeOrchestrator = {
    runMissionCore: vi.fn().mockResolvedValue({ exitCode: 0, output: 'resumed' }),
  } as unknown as AgentOrchestrator

  orchestratorRegistry.set(missionId, fakeOrchestrator)

  vi.spyOn(workspaceManager, 'allocateWorkspace').mockResolvedValue({ path: '/tmp/ws' })
  vi.mocked(workspacePriming.hydrateStateFromCheckpoint).mockResolvedValue('{"artifacts": []}')

  await resumeMissionFromCheckpoint(missionId)

  expect(workspaceManager.allocateWorkspace).toHaveBeenCalledWith('user-123', 'project-1', {
    repository: 'owner/repo',
  })
  expect(workspacePriming.hydrateStateFromCheckpoint).toHaveBeenCalledWith('/tmp/ws')

  expect(fakeOrchestrator.runMissionCore).toHaveBeenCalled()
  const calledMission = vi.mocked(fakeOrchestrator.runMissionCore).mock.calls[0][0]
  expect(calledMission.waitingStatus).toBe('resuming')
  expect(calledMission.id).toBe(missionId)
})
