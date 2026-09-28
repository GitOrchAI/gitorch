import { describe, it, expect, vi } from 'vitest'
import { AgentOrchestrator } from './orchestrator.js'
import type { RuntimeRegistry } from './runtime-adapter.js'
import type { AgentMission } from './types.js'

describe('AgentOrchestrator', () => {
  it('calls onStepDispatched before adapter.run', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        output: '',
        stderr: '',
        durationMs: 0,
      }),
    }
    const mockRegistry = {
      resolve: vi.fn().mockReturnValue(mockAdapter),
    } as unknown as RuntimeRegistry

    const onStepDispatched = vi.fn().mockResolvedValue(undefined)

    const orchestrator = new AgentOrchestrator({
      registry: mockRegistry,
      onStepDispatched,
    })

    const mission = {
      id: 'mission-1',
      projectId: 'proj-1',
      repository: 'repo-1',
      role: 'dev',
      goal: 'test goal',
      prompt: 'test prompt',
      runtime: { runtime: 'claude' },
      credentialRef: {
        connectionId: 'conn-1',
        ownerScope: 'project',
        runtime: 'claude',
        providedSecrets: [],
      },
      evidenceRefs: [],
    } as unknown as AgentMission

    await orchestrator.runMissionCore(mission)

    expect(onStepDispatched).toHaveBeenCalledWith(mission)
    // Check it was called before adapter.run (vitest mock order)
    const orderOnStepDispatched = onStepDispatched.mock.invocationCallOrder[0]
    const orderAdapterRun = mockAdapter.run.mock.invocationCallOrder[0]
    expect(orderOnStepDispatched).toBeLessThan(orderAdapterRun)
  })
})
