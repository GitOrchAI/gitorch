import { missionStateReducer } from './agent-mission'
import type { MissionState, AgentMission } from './types'

test('missionStateReducer merges basic state fields', () => {
  const initialMission: AgentMission = {
    id: 'm1',
    projectId: 'p1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Test',
    prompt: 'Prompt',
    runtime: { runtime: 'codex' },
    credentialRef: {
      connectionId: 'c1',
      ownerScope: 'user',
      runtime: 'codex',
      providedSecrets: [],
    },
    evidenceRefs: [],
  }

  const state: MissionState = {
    mission: initialMission,
    timeoutMs: 1000,
  }

  const updatedState = missionStateReducer(state, {
    workspacePath: '/tmp/ws',
    timeoutMs: 2000,
  })

  expect(updatedState.workspacePath).toBe('/tmp/ws')
  expect(updatedState.timeoutMs).toBe(2000)
  expect(updatedState.mission).toBe(initialMission)
})

test('missionStateReducer protects core mission fields from falsy updates', () => {
  const initialMission: AgentMission = {
    id: 'm1',
    projectId: 'p1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Test',
    prompt: 'Prompt',
    runtime: { runtime: 'codex' },
    credentialRef: {
      connectionId: 'c1',
      ownerScope: 'user',
      runtime: 'codex',
      providedSecrets: [],
    },
    evidenceRefs: [],
  }

  const state: MissionState = {
    mission: initialMission,
  }

  const updatedState = missionStateReducer(state, {
    mission: {
      id: '', // Should be ignored because it's falsy
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projectId: null as any,
      repository: undefined,
      waitingStatus: 'waiting',
      waitingReason: 'reason',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })

  expect(updatedState.mission.id).toBe('m1')
  expect(updatedState.mission.projectId).toBe('p1')
  expect(updatedState.mission.repository).toBe('owner/repo')
  expect(updatedState.mission.waitingStatus).toBe('waiting')
  expect(updatedState.mission.waitingReason).toBe('reason')
})
