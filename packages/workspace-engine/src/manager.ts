import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

export interface WorkspaceInfo {
  id: string
  userId: string
  projectId: string
  path: string
  status: 'active' | 'hibernated'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any
}

export class WorkspaceManager {
  private baseDir = '/var/lib/gitorch/workspaces'

  private validateInput(value: string): void {
    const regex = /^[a-zA-Z0-9_-]+$/
    if (!regex.test(value)) {
      throw new Error(
        `Entrada inválida detectada: "${value}". Apenas letras, números, hifens e underscores são permitidos.`
      )
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async allocateWorkspace(userId: string, projectId: string, config?: any): Promise<WorkspaceInfo> {
    this.validateInput(userId)
    this.validateInput(projectId)

    const workspaceId = `ws:${userId}:${projectId}`
    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    await fs.mkdir(workspacePath, { recursive: true })

    const jailerId = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)

    await execFileAsync('jailer', [
      '--id',
      jailerId,
      '--node',
      '0',
      '--exec-file',
      '/usr/local/bin/firecracker',
      '--uid',
      '1000',
      '--gid',
      '1000',
      '--chroot-base-dir',
      workspacePath,
    ])

    return {
      id: workspaceId,
      userId,
      projectId,
      path: workspacePath,
      status: 'active',
      config,
    }
  }

  async hibernateWorkspace(userId: string, projectId: string): Promise<void> {
    this.validateInput(userId)
    this.validateInput(projectId)

    const workspaceId = `ws:${userId}:${projectId}`
    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    const socketPath = path.posix.join(workspacePath, 'firecracker.socket')
    const snapshotPath = path.posix.join(workspacePath, 'snapshot.bin')
    const memPath = path.posix.join(workspacePath, 'mem.bin')

    const jailerId = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)

    await execFileAsync('curl', [
      '--unix-socket',
      socketPath,
      '-X',
      'PUT',
      'http://localhost/snapshot/create',
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({ snapshot_path: snapshotPath, mem_file_path: memPath }),
    ])

    try {
      await execFileAsync('pkill', ['-f', `firecracker.*${jailerId}`])
    } catch (err) {
      if ((err as { code?: unknown }).code !== 1) {
        throw err
      }
    }
  }

  async cloneRepositories(workspaceId: string, repos: string[]): Promise<void> {
    const parts = workspaceId.split(':')
    if (parts.length < 3 || parts[0] !== 'ws') {
      throw new Error(`Workspace ID inválido: ${workspaceId}`)
    }
    const userId = parts[1]!
    const projectId = parts.slice(2).join(':')

    this.validateInput(userId)
    this.validateInput(projectId)

    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    for (const repo of repos) {
      await execFileAsync('git', ['clone', repo, path.posix.join(workspacePath, 'src')])
    }
  }

  async installRuntimes(workspaceId: string, runtimes: string[]): Promise<void> {
    const parts = workspaceId.split(':')
    if (parts.length < 3 || parts[0] !== 'ws') {
      throw new Error(`Workspace ID inválido: ${workspaceId}`)
    }
    const userId = parts[1]!
    const projectId = parts.slice(2).join(':')

    this.validateInput(userId)
    this.validateInput(projectId)

    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    for (const runtime of runtimes) {
      await execFileAsync('chroot', [workspacePath, 'apt-get', 'install', '-y', runtime])
    }
  }
}
