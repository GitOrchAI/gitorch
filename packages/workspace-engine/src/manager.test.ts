import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkspaceManager } from './manager.js'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'

// Mocar child_process.execFile
vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn((file, args, options, cb) => {
      const callback =
        typeof cb === 'function' ? cb : typeof options === 'function' ? options : null
      if (callback) {
        callback(null, { stdout: '', stderr: '' })
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

    // Verificar se executou o comando jailer via execFile
    expect(execFile).toHaveBeenCalled()
    const calls = vi.mocked(execFile).mock.calls
    const jailerCall = calls.find((call) => call[0] === 'jailer')
    expect(jailerCall).toBeDefined()
    expect(jailerCall![1]).toContain('wsuser123projectabc')
    expect(jailerCall![1]).toContain('/var/lib/gitorch/workspaces/user-123/project-abc')
  })

  it('should hibernate a workspace', async () => {
    const userId = 'user-123'
    const projectId = 'project-abc'
    await manager.hibernateWorkspace(userId, projectId)

    expect(execFile).toHaveBeenCalled()
    const calls = vi.mocked(execFile).mock.calls

    // Verificar se chamou curl para o socket do Firecracker
    const curlCall = calls.find(
      (call) =>
        call[0] === 'curl' &&
        call[1]?.includes('/var/lib/gitorch/workspaces/user-123/project-abc/firecracker.socket')
    )
    expect(curlCall).toBeDefined()

    // Verificar se enviou sinal de kill/pkill para o processo correspondente ao workspace
    const killCall = calls.find(
      (call) => call[0] === 'pkill' && call[1]?.some((arg) => arg.includes('wsuser123projectabc'))
    )
    expect(killCall).toBeDefined()
  })

  it('should clone repositories into workspace', async () => {
    const workspaceId = 'ws:user-123:project-abc'
    const repos = ['https://github.com/foo/bar.git']
    await manager.cloneRepositories(workspaceId, repos)

    expect(execFile).toHaveBeenCalled()
    const calls = vi.mocked(execFile).mock.calls

    // Verificar se chamou git clone na pasta correta
    const cloneCall = calls.find(
      (call) =>
        call[0] === 'git' &&
        call[1]?.[0] === 'clone' &&
        call[1]?.[2] === '/var/lib/gitorch/workspaces/user-123/project-abc/src'
    )
    expect(cloneCall).toBeDefined()
  })

  it('should install runtimes in the workspace', async () => {
    const workspaceId = 'ws:user-123:project-abc'
    const runtimes = ['nodejs20', 'python3']
    await manager.installRuntimes(workspaceId, runtimes)

    expect(execFile).toHaveBeenCalled()
    const calls = vi.mocked(execFile).mock.calls

    // Verificar se chamou chroot para instalar os runtimes
    const nodejsCall = calls.find(
      (call) =>
        call[0] === 'chroot' &&
        call[1]?.[0] === '/var/lib/gitorch/workspaces/user-123/project-abc' &&
        call[1]?.includes('nodejs20')
    )
    const pythonCall = calls.find(
      (call) =>
        call[0] === 'chroot' &&
        call[1]?.[0] === '/var/lib/gitorch/workspaces/user-123/project-abc' &&
        call[1]?.includes('python3')
    )

    expect(nodejsCall).toBeDefined()
    expect(pythonCall).toBeDefined()
  })

  describe('Security and Input Validation', () => {
    const invalidInputs = [
      '../user',
      'user/../../etc',
      'user; rm -rf /',
      'user&&cmd',
      'user|cmd',
      'user\ncmd',
      'user\rworkspace',
      'user$',
      'user`cmd`',
      ' ',
      '',
    ]

    it('should throw an error for invalid userId in allocateWorkspace', async () => {
      for (const invalid of invalidInputs) {
        await expect(manager.allocateWorkspace(invalid, 'project-abc')).rejects.toThrow()
      }
    })

    it('should throw an error for invalid projectId in allocateWorkspace', async () => {
      for (const invalid of invalidInputs) {
        await expect(manager.allocateWorkspace('user-123', invalid)).rejects.toThrow()
      }
    })

    it('should throw an error for invalid inputs in hibernateWorkspace', async () => {
      for (const invalid of invalidInputs) {
        await expect(manager.hibernateWorkspace(invalid, 'project-abc')).rejects.toThrow()
        await expect(manager.hibernateWorkspace('user-123', invalid)).rejects.toThrow()
      }
    })

    it('should throw an error for invalid inputs in cloneRepositories via workspaceId', async () => {
      for (const invalid of invalidInputs) {
        await expect(
          manager.cloneRepositories(`ws:${invalid}:project-abc`, ['repo'])
        ).rejects.toThrow()
        await expect(
          manager.cloneRepositories(`ws:user-123:${invalid}`, ['repo'])
        ).rejects.toThrow()
      }
    })

    it('should throw an error for invalid inputs in installRuntimes via workspaceId', async () => {
      for (const invalid of invalidInputs) {
        await expect(
          manager.installRuntimes(`ws:${invalid}:project-abc`, ['runtime'])
        ).rejects.toThrow()
        await expect(
          manager.installRuntimes(`ws:user-123:${invalid}`, ['runtime'])
        ).rejects.toThrow()
      }
    })
  })
})
