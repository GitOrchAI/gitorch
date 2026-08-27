import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'

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

export class WorkspaceManager extends EventEmitter {
  private baseDir = '/var/lib/gitorch/workspaces'

  constructor() {
    super()
  }

  handleRuntimeFailure(errorDetails: string, stepName: string, rollback: boolean) {
    const payload = {
      failedStep: stepName,
      errorDetails,
      recoveryAction: rollback ? 'auto-rollback' : 'none',
    }
    console.error(`[WorkspaceManager] Step failed: ${payload.failedStep}. Recovery action: ${payload.recoveryAction}. Details: ${payload.errorDetails}`)
    this.emit('workspace-error', payload)
  }

  private validateInput(value: string): void {
    const regex = /^[a-zA-Z0-9_-]+$/
    if (!regex.test(value)) {
      throw new Error(
        `Entrada inválida detectada: "${value}". Apenas letras, números, hifens e underscores são permitidos.`
      )
    }
  }

  private validateRepo(repo: string): void {
    if (repo.startsWith('-')) {
      throw new Error(`URL de repositório inválida: "${repo}" não pode começar com hífen.`)
    }
    // Validação básica para evitar injeção em argumentos de comandos que não suportam --
    // ou como medida de defesa em profundidade.
    const forbiddenChars = [';', '&', '|', '$', '`', '(', ')', '<', '>', '\n', '\r']
    if (forbiddenChars.some((char) => repo.includes(char))) {
      throw new Error(`URL de repositório inválida: "${repo}" contém caracteres proibidos.`)
    }
  }

  private validateRuntime(runtime: string): void {
    const regex = /^[a-zA-Z0-9.-]+$/
    if (!regex.test(runtime)) {
      throw new Error(
        `Runtime inválido: "${runtime}". Apenas letras, números, hifens e pontos são permitidos.`
      )
    }
    if (runtime.startsWith('-')) {
      throw new Error(`Runtime inválido: "${runtime}" não pode começar com hífen.`)
    }
  }

  private getWorkspacePath(userId: string, projectId: string): string {
    this.validateInput(userId)
    this.validateInput(projectId)

    // Sanitiza os valores de entrada
    const sanitizedUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_')

    // Constrói o caminho absoluto e garante que ele permaneça dentro de this.baseDir
    const workspacePath = path.resolve(this.baseDir, sanitizedUserId, sanitizedProjectId)
    if (!workspacePath.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Caminho fora da raiz permitida')
    }
    return workspacePath
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async allocateWorkspace(userId: string, projectId: string, config?: any): Promise<WorkspaceInfo> {
    const workspaceId = `ws:${userId}:${projectId}`
    const workspacePath = this.getWorkspacePath(userId, projectId)

    try {
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
    } catch (err) {
      this.emit('workspace-error', {
        failedStep: 'allocateWorkspace',
        errorDetails: String(err),
        recoveryAction: 'auto-rollback',
      })
      await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  async hibernateWorkspace(userId: string, projectId: string): Promise<void> {
    const workspaceId = `ws:${userId}:${projectId}`
    const workspacePath = this.getWorkspacePath(userId, projectId)

    const socketPath = path.posix.join(workspacePath, 'firecracker.socket')
    const snapshotPath = path.posix.join(workspacePath, 'snapshot.bin')
    const memPath = path.posix.join(workspacePath, 'mem.bin')

    const jailerId = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)

    try {
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
    } catch (err) {
      this.emit('workspace-error', {
        failedStep: 'hibernateWorkspace',
        errorDetails: String(err),
        recoveryAction: 'none',
      })
      throw err
    }
  }

  async cloneRepositories(workspaceId: string, repos: string[]): Promise<void> {
    const parts = workspaceId.split(':')
    if (parts.length < 3 || parts[0] !== 'ws') {
      throw new Error(`Workspace ID inválido: ${workspaceId}`)
    }
    const userId = parts[1]!
    const projectId = parts.slice(2).join(':')

    const workspacePath = this.getWorkspacePath(userId, projectId)

    try {
      for (const repo of repos) {
        this.validateRepo(repo)
        await execFileAsync('git', ['clone', '--', repo, path.posix.join(workspacePath, 'src')])
      }
    } catch (err) {
      this.emit('workspace-error', {
        failedStep: 'cloneRepositories',
        errorDetails: String(err),
        recoveryAction: 'none',
      })
      throw err
    }
  }

  async installRuntimes(workspaceId: string, runtimes: string[]): Promise<void> {
    const parts = workspaceId.split(':')
    if (parts.length < 3 || parts[0] !== 'ws') {
      throw new Error(`Workspace ID inválido: ${workspaceId}`)
    }
    const userId = parts[1]!
    const projectId = parts.slice(2).join(':')

    const workspacePath = this.getWorkspacePath(userId, projectId)

    try {
      for (const runtime of runtimes) {
        this.validateRuntime(runtime)
        await execFileAsync('chroot', [workspacePath, 'apt-get', 'install', '-y', '--', runtime])
      }
    } catch (err) {
      this.emit('workspace-error', {
        failedStep: 'installRuntimes',
        errorDetails: String(err),
        recoveryAction: 'none',
      })
      throw err
    }
  }
}
