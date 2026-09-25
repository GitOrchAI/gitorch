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
    },
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
    runtime: { runtime: 'codex' },
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(result.output).toBe('PO normalized issue')
  expect(mockAllocateWorkspace).toHaveBeenCalledWith('user-default', 'project-1', {
    repository: 'owner/repo',
  })
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
    runtime: { runtime: 'codex' },
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(result.output).toBe('')
  expect(mockAllocateWorkspace).toHaveBeenCalledWith('user-default', 'project-1', {
    repository: 'owner/repo',
  })
  expect(mockHibernateWorkspace).toHaveBeenCalledWith('user-default', 'project-1')
  const completedEvent = synapse.events().find((event) => event.type === 'execution.completed')
  expect(completedEvent).toBeDefined()
  expect(completedEvent?.payload.status).toBe('blocked')
})

test('bubbles up step-level failure and recovery status to the workspace provider when the runtime adapter fails', async () => {
  const allocate = vi.fn().mockResolvedValue({ path: '/tmp/ws' })
  const hibernate = vi.fn().mockResolvedValue(undefined)
  const handleRuntimeFailure = vi.fn()

  const runner: RuntimeCommandRunner = async () => {
    throw new Error('Adapter explosion')
  }

  const registry = new RuntimeRegistry()
  registry.register(
    createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['--print'], runner })
  )

  const orchestrator = new AgentOrchestrator({
    registry,
    synapse: new SynapseClient(),
    workspace: { allocateWorkspace: allocate, hibernateWorkspace: hibernate, handleRuntimeFailure },
  })

  await orchestrator.runMission({
    id: 'mission-failed-deploy',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'qa',
    goal: 'Test deployment failure',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: [],
    },
    userId: 'qa-user',
  })

  expect(handleRuntimeFailure).toHaveBeenCalledWith('Adapter explosion', 'execute-runner', false)
})

test('retries runMissionCore when adapter returns waiting_quota and scales backoff exponentially', async () => {
  mockAllocateWorkspace.mockClear()
  mockHibernateWorkspace.mockClear()
  vi.useFakeTimers()

  let attempts = 0
  const runner: RuntimeCommandRunner = async () => {
    attempts++
    if (attempts === 1) {
      return { exitCode: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests', durationMs: 5 }
    }
    return { exitCode: 0, stdout: 'success after quota recovered', stderr: '', durationMs: 5 }
  }

  const registry = new RuntimeRegistry()
  registry.register(
    createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['exec'], runner })
  )
  const synapse = new SynapseClient()
  const orchestrator = new AgentOrchestrator({ registry, synapse })

  const runPromise = orchestrator.runMission({
    id: 'mission-quota-retry',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Retry logic test',
    context: [],
    runtime: { runtime: 'codex' },
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: [],
    },
  })

  // Advance timers enough to trigger the backoff setTimeout.
  // The first attempt throws waiting_quota -> BACKOFF_CONFIG.baseDelay = 5000.
  // Then the next attempt will succeed.
  await vi.advanceTimersByTimeAsync(6000)
  const result = await runPromise

  vi.useRealTimers()

  expect(attempts).toBe(2)
  expect(result.output).toBe('success after quota recovered')
  expect(result.exitCode).toBe(0)
  expect(result.waitingStatus).toBeUndefined()
})

test('uses an injected workspace provider instead of the default Firecracker manager', async () => {
  mockAllocateWorkspace.mockClear()
  mockHibernateWorkspace.mockClear()

  const allocate = vi.fn().mockResolvedValue({ path: '/tmp/ws' })
  const hibernate = vi.fn().mockResolvedValue(undefined)

  const runner: RuntimeCommandRunner = async () => ({
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 5,
  })
  const registry = new RuntimeRegistry()
  registry.register(
    createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['--print'], runner })
  )
  const orchestrator = new AgentOrchestrator({
    registry,
    synapse: new SynapseClient(),
    workspace: { allocateWorkspace: allocate, hibernateWorkspace: hibernate },
  })

  await orchestrator.runMission({
    id: 'mission-3',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'ra',
    goal: 'Analyze repository',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: [],
    },
    userId: 'scheduler-user',
  })

  expect(allocate).toHaveBeenCalledWith('scheduler-user', 'project-1', {
    repository: 'owner/repo',
  })
  expect(hibernate).toHaveBeenCalledWith('scheduler-user', 'project-1')
  expect(mockAllocateWorkspace).not.toHaveBeenCalled()
  expect(mockHibernateWorkspace).not.toHaveBeenCalled()
})

describe('Multi-Repo Mission Plans', () => {
  test('orders a 4-repository mission plan topologically', () => {
    const registry = new RuntimeRegistry()
    const synapse = new SynapseClient()
    const orchestrator = new AgentOrchestrator({ registry, synapse })

    const plan = {
      items: [
        {
          id: 'automation',
          repositoryKey: 'owner/automation',
          subPath: '/',
          crossRepoPrerequisites: ['owner/frontend'],
          goal: 'Add automation worker',
          role: 'dev' as const,
        },
        {
          id: 'backend',
          repositoryKey: 'owner/backend',
          subPath: '/',
          crossRepoPrerequisites: ['owner/database'],
          goal: 'Add endpoint',
          role: 'dev' as const,
        },
        {
          id: 'frontend',
          repositoryKey: 'owner/frontend',
          subPath: '/',
          crossRepoPrerequisites: ['owner/backend'],
          goal: 'Add button',
          role: 'dev' as const,
        },
        {
          id: 'database',
          repositoryKey: 'owner/database',
          subPath: '/',
          crossRepoPrerequisites: [],
          goal: 'Add migration',
          role: 'dev' as const,
        },
      ],
    }

    const ordered = orchestrator.orderMissionPlan(plan)
    const repoKeys = ordered.map((item) => item.repositoryKey)
    expect(repoKeys).toEqual([
      'owner/database',
      'owner/backend',
      'owner/frontend',
      'owner/automation',
    ])
  })

  test('aborts execution downstream if an upstream task fails', async () => {
    mockAllocateWorkspace.mockClear()
    mockHibernateWorkspace.mockClear()

    const runner: RuntimeCommandRunner = async (request) => {
      if (request.args && request.args.some((a) => a.includes('owner/backend'))) {
        return { exitCode: 1, stdout: '', stderr: 'Build failed', durationMs: 10 }
      }
      return { exitCode: 0, stdout: 'Success', stderr: '', durationMs: 10 }
    }
    const registry = new RuntimeRegistry()
    registry.register(
      createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['exec'], runner })
    )
    const synapse = new SynapseClient()
    const orchestrator = new AgentOrchestrator({ registry, synapse })

    const plan = {
      items: [
        {
          id: 'backend',
          repositoryKey: 'owner/backend',
          subPath: '/',
          crossRepoPrerequisites: ['owner/database'],
          goal: 'Add endpoint',
          role: 'dev' as const,
        },
        {
          id: 'frontend',
          repositoryKey: 'owner/frontend',
          subPath: '/',
          crossRepoPrerequisites: ['owner/backend'],
          goal: 'Add button',
          role: 'dev' as const,
        },
        {
          id: 'database',
          repositoryKey: 'owner/database',
          subPath: '/',
          crossRepoPrerequisites: [],
          goal: 'Add migration',
          role: 'dev' as const,
        },
      ],
    }

    const inputTpl = {
      projectId: 'proj-1',
      context: [],
      runtime: { runtime: 'codex' as const },
      credentialRef: {
        connectionId: 'conn-1',
        ownerScope: 'project' as const,
        runtime: 'codex' as const,
        providedSecrets: [],
      },
    }

    const results = await orchestrator.executeMissionPlan(plan, inputTpl)
    expect(results.length).toBe(2) // database succeeds, backend fails, frontend never runs
    expect(results[0].exitCode).toBe(0)
    expect(results[1].exitCode).toBe(1)
  })

  test('detects cyclic dependencies', () => {
    const registry = new RuntimeRegistry()
    const synapse = new SynapseClient()
    const orchestrator = new AgentOrchestrator({ registry, synapse })

    const plan = {
      items: [
        {
          id: 'a',
          repositoryKey: 'owner/a',
          subPath: '/',
          crossRepoPrerequisites: ['owner/b'],
          goal: 'A',
          role: 'dev' as const,
        },
        {
          id: 'b',
          repositoryKey: 'owner/b',
          subPath: '/',
          crossRepoPrerequisites: ['owner/a'],
          goal: 'B',
          role: 'dev' as const,
        },
      ],
    }

    expect(() => orchestrator.orderMissionPlan(plan)).toThrow(/Cyclic dependency detected/)
  })

  test('ignores unaffected repositories not present in the plan', async () => {
    mockAllocateWorkspace.mockClear()
    mockHibernateWorkspace.mockClear()

    const runner: RuntimeCommandRunner = async () => {
      return { exitCode: 0, stdout: 'Success', stderr: '', durationMs: 10 }
    }
    const registry = new RuntimeRegistry()
    registry.register(
      createCliRuntimeAdapter({ runtime: 'codex', binary: 'codex', args: ['exec'], runner })
    )
    const synapse = new SynapseClient()
    const orchestrator = new AgentOrchestrator({ registry, synapse })

    const plan = {
      items: [
        {
          id: 'repo-a',
          repositoryKey: 'owner/repo-a',
          subPath: '/',
          crossRepoPrerequisites: [],
          goal: 'Add task',
          role: 'dev' as const,
        },
      ],
    }

    const inputTpl = {
      projectId: 'proj-1',
      context: [],
      runtime: { runtime: 'codex' as const },
      credentialRef: {
        connectionId: 'conn-1',
        ownerScope: 'project' as const,
        runtime: 'codex' as const,
        providedSecrets: [],
      },
    }

    const results = await orchestrator.executeMissionPlan(plan, inputTpl)
    expect(results.length).toBe(1)
    expect(results[0].missionId).toBe('repo-a')
  })
})
