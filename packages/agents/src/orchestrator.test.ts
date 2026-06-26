import { vi } from 'vitest'
import { SynapseClient } from '@gitorch/synapse'
import { AgentOrchestrator } from './orchestrator'
import {
  RuntimeRegistry,
  createCliRuntimeAdapter,
  type RuntimeCommandRunner,
} from './runtime-adapter'

const { mockAllocateWorkspace, mockHibernateWorkspace } = vi.hoisted(() => {
  return {
    mockAllocateWorkspace: vi.fn().mockResolvedValue({
      id: 'ws:user-default:project-1',
      userId: 'user-default',
      projectId: 'project-1',
      path: '/var/lib/gitorch/workspaces/user-default/project-1',
      status: 'active',
    }),
    mockHibernateWorkspace: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@gitorch/workspace-engine', () => {
  return {
    WorkspaceManager: class {
      allocateWorkspace = mockAllocateWorkspace
      hibernateWorkspace = mockHibernateWorkspace
      cloneRepositories = vi.fn()
      installRuntimes = vi.fn()
    }
  }
})

test('runs an agent mission through the selected runtime and records Synapse execution', async () => {
  mockAllocateWorkspace.mockClear()
  mockHibernateWorkspace.mockClear()

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
  expect(mockAllocateWorkspace).toHaveBeenCalledWith('user-default', 'project-1')
  expect(mockHibernateWorkspace).toHaveBeenCalledWith('user-default', 'project-1')
  expect(synapse.events().map((event) => event.type)).toEqual([
    'execution.started',
    'execution.completed',
  ])
  const completedEvent = synapse.events().find((event) => event.type === 'execution.completed')
  expect(completedEvent?.payload.status).toBe('completed')
})

test('records Synapse execution as blocked when the mission fails (exitCode != 0)', async () => {
  mockAllocateWorkspace.mockClear()
  mockHibernateWorkspace.mockClear()

  const runner: RuntimeCommandRunner = async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'Failed to normalize issue',
    durationMs: 10,
  })
  const registry = new RuntimeRegistry()
  registry.register(
    createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['exec'], runner })
  )
  const synapse = new SynapseClient()
  const orchestrator = new AgentOrchestrator({ registry, synapse })

  const result = await orchestrator.runMission({
    id: 'mission-2',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Normalize issue #2',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(result.output).toBe('')
  expect(mockAllocateWorkspace).toHaveBeenCalledWith('user-default', 'project-1')
  expect(mockHibernateWorkspace).toHaveBeenCalledWith('user-default', 'project-1')
  const completedEvent = synapse.events().find((event) => event.type === 'execution.completed')
  expect(completedEvent).toBeDefined()
  expect(completedEvent?.payload.status).toBe('blocked')
})
