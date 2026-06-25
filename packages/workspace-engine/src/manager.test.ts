import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkspaceManager } from './manager.js'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'

// Mocar child_process
vi.mock('node:child_process', () => {
  return {
    exec: vi.fn((cmd, cb) => {
      if (cb) {
        cb(null, { stdout: '', stderr: '' })
      }
      return {}
    }),
  }
})

// Mocar fs/promises
vi.mock('node:fs/promises', () => {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
  }
})

describe('WorkspaceManager', () => {
  let manager: WorkspaceManager

  beforeEach(() => {
    manager = new WorkspaceManager()
    vi.clearAllMocks()
  })

  it('should allocate a workspace correctly mapping to the isolated path', async () => {
    const userId = 'user-123'
    const projectId = 'project-abc'
    const info = await manager.allocateWorkspace(userId, projectId)

    expect(info.id).toBe('ws:user-123:project-abc')
    expect(info.userId).toBe(userId)
    expect(info.projectId).toBe(projectId)
    expect(info.path).toBe(`/var/lib/gitorch/workspaces/${userId}/${projectId}`)
    expect(info.status).toBe('active')

    // Verificar se o mkdir foi chamado com o caminho correto
    expect(fs.mkdir).toHaveBeenCalledWith(`/var/lib/gitorch/workspaces/${userId}/${projectId}`, {
      recursive: true,
    })

    // Verificar se executou o comando jailer
    expect(exec).toHaveBeenCalled()
    const calls = vi.mocked(exec).mock.calls
    const jailerCall = calls.find((call) => call[0].includes('jailer'))
    expect(jailerCall).toBeDefined()
    expect(jailerCall![0]).toContain('--id wsuser123projectabc')
    expect(jailerCall![0]).toContain(
      '--chroot-base-dir /var/lib/gitorch/workspaces/user-123/project-abc'
    )
  })

  it('should hibernate a workspace', async () => {
    const userId = 'user-123'
    const projectId = 'project-abc'
    await manager.hibernateWorkspace(userId, projectId)

    expect(exec).toHaveBeenCalled()
    const calls = vi.mocked(exec).mock.calls

    // Verificar se chamou curl para o socket do Firecracker
    const curlCall = calls.find(
      (call) => call[0].includes('curl') && call[0].includes('firecracker.socket')
    )
    expect(curlCall).toBeDefined()

    // Verificar se enviou sinal de kill/pkill para o processo correspondente ao workspace
    const killCall = calls.find(
      (call) => call[0].includes('pkill') && call[0].includes('wsuser123projectabc')
    )
    expect(killCall).toBeDefined()
  })

  it('should clone repositories into workspace', async () => {
    const workspaceId = 'ws:user-123:project-abc'
    const repos = ['https://github.com/foo/bar.git']
    await manager.cloneRepositories(workspaceId, repos)

    expect(exec).toHaveBeenCalled()
    const calls = vi.mocked(exec).mock.calls

    // Verificar se chamou git clone na pasta correta
    const cloneCall = calls.find(
      (call) =>
        call[0].includes('git clone') &&
        call[0].includes('/var/lib/gitorch/workspaces/user-123/project-abc/src')
    )
    expect(cloneCall).toBeDefined()
  })

  it('should install runtimes in the workspace', async () => {
    const workspaceId = 'ws:user-123:project-abc'
    const runtimes = ['nodejs20', 'python3']
    await manager.installRuntimes(workspaceId, runtimes)

    expect(exec).toHaveBeenCalled()
    const calls = vi.mocked(exec).mock.calls

    // Verificar se chamou chroot para instalar os runtimes
    const nodejsCall = calls.find(
      (call) => call[0].includes('chroot') && call[0].includes('apt-get install -y nodejs20')
    )
    const pythonCall = calls.find(
      (call) => call[0].includes('chroot') && call[0].includes('apt-get install -y python3')
    )

    expect(nodejsCall).toBeDefined()
    expect(pythonCall).toBeDefined()
  })
})
