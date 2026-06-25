import { SynapseClient } from '@gitorch/synapse'
import { AgentOrchestrator } from './orchestrator'
import {
  RuntimeRegistry,
  createCliRuntimeAdapter,
  type RuntimeCommandRunner,
} from './runtime-adapter'

test('runs an agent mission through the selected runtime and records Synapse execution', async () => {
  const runner: RuntimeCommandRunner = async () => ({
    exitCode: 0,
    stdout: 'PO normalized issue',
    stderr: '',
    durationMs: 10,
  })
  const registry = new RuntimeRegistry()
  registry.register(
    createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['exec'], runner })
  )
  const synapse = new SynapseClient()
  const orchestrator = new AgentOrchestrator({ registry, synapse })

  const result = await orchestrator.runMission({
    id: 'mission-1',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Normalize issue #1',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(result.output).toBe('PO normalized issue')
  expect(synapse.events().map((event) => event.type)).toEqual([
    'execution.started',
    'execution.completed',
  ])
})
