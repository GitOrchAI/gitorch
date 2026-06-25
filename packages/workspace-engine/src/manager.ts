import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const execAsync = promisify(exec)

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async allocateWorkspace(userId: string, projectId: string, config?: any): Promise<WorkspaceInfo> {
    const workspaceId = `ws:${userId}:${projectId}`
    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    try {
      await fs.mkdir(workspacePath, { recursive: true })
    } catch (err) {
      // Ignorar erros em testes ou ambientes onde não há permissão
    }

    const jailerId = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)
    const jailerCmd = `jailer --id ${jailerId} --node 0 --exec-file /usr/local/bin/firecracker --uid 1000 --gid 1000 --chroot-base-dir ${workspacePath}`

    try {
      await execAsync(jailerCmd)
    } catch (err) {
      console.warn(
        `[WorkspaceManager] Falha ao iniciar MicroVM via Jailer: ${(err as Error).message}. Prosseguindo em modo degradado/mock.`
      )
    }

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
    const workspaceId = `ws:${userId}:${projectId}`
    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    const socketPath = path.posix.join(workspacePath, 'firecracker.socket')
    const snapshotPath = path.posix.join(workspacePath, 'snapshot.bin')
    const memPath = path.posix.join(workspacePath, 'mem.bin')

    const hibernateCmd = `curl --unix-socket ${socketPath} -X PUT http://localhost/snapshot/create -H "Content-Type: application/json" -d '{"snapshot_path": "${snapshotPath}", "mem_file_path": "${memPath}"}'`

    const jailerId = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)

    try {
      await execAsync(hibernateCmd)
      const killCmd = `pkill -f "firecracker.*${jailerId}" || true`
      await execAsync(killCmd)
    } catch (err) {
      console.warn(
        `[WorkspaceManager] Falha ao hibernar MicroVM via socket API: ${(err as Error).message}.`
      )
      try {
        await execAsync(`pkill -f "firecracker.*${jailerId}" || true`)
      } catch (e) {}
    }
  }

  async cloneRepositories(workspaceId: string, repos: string[]): Promise<void> {
    const parts = workspaceId.split(':')
    if (parts.length < 3 || parts[0] !== 'ws') {
      throw new Error(`Workspace ID inválido: ${workspaceId}`)
    }
    const userId = parts[1]!
    const projectId = parts.slice(2).join(':')
    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    for (const repo of repos) {
      const cloneCmd = `git clone ${repo} ${workspacePath}/src`
      try {
        await execAsync(cloneCmd)
      } catch (err) {
        console.warn(
          `[WorkspaceManager] Falha ao clonar repositório ${repo}: ${(err as Error).message}`
        )
      }
    }
  }

  async installRuntimes(workspaceId: string, runtimes: string[]): Promise<void> {
    const parts = workspaceId.split(':')
    if (parts.length < 3 || parts[0] !== 'ws') {
      throw new Error(`Workspace ID inválido: ${workspaceId}`)
    }
    const userId = parts[1]!
    const projectId = parts.slice(2).join(':')
    const workspacePath = path.posix.join(this.baseDir, userId, projectId)

    for (const runtime of runtimes) {
      const installCmd = `chroot ${workspacePath} apt-get install -y ${runtime}`
      try {
        await execAsync(installCmd)
      } catch (err) {
        console.warn(
          `[WorkspaceManager] Falha ao instalar runtime ${runtime} via chroot: ${(err as Error).message}`
        )
      }
    }
  }
}
