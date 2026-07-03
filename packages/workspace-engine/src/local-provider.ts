import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LocalWorkspaceInfo {
  id: string
  userId: string
  projectId: string
  path: string
  status: 'active' | 'hibernated'
}

/**
 * Provedor de workspace por processo local (executor `local-process`).
 *
 * Aloca apenas um diretório isolado por usuário/projeto, sem MicroVM.
 * Usado quando o host não suporta Firecracker (sem /dev/kvm) ou quando o
 * modo de execução configurado é `local-process`. O isolamento forte por
 * tenant (container/microVM) é pré-requisito para aceitar clientes externos,
 * não para o modo single-tenant.
 */
export class LocalWorkspaceProvider {
  private baseDir: string

  constructor(baseDir = '/var/lib/gitorch/workspaces') {
    this.baseDir = baseDir
  }

  private validateInput(value: string): void {
    const regex = /^[a-zA-Z0-9_-]+$/
    if (!regex.test(value)) {
      throw new Error(
        `Entrada inválida detectada: "${value}". Apenas letras, números, hifens e underscores são permitidos.`
      )
    }
  }

  private validateRepository(repository: string): void {
    // Formato owner/repo do GitHub; bloqueia injeção de argumento/URL.
    const regex = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/
    if (!regex.test(repository) || repository.startsWith('-')) {
      throw new Error(`Repositório inválido: "${repository}". Esperado formato owner/repo.`)
    }
  }

  async allocateWorkspace(
    userId: string,
    projectId: string,
    options?: { repository?: string }
  ): Promise<LocalWorkspaceInfo> {
    this.validateInput(userId)
    this.validateInput(projectId)

    const workspacePath = path.posix.join(this.baseDir, userId, projectId)
    await fs.mkdir(workspacePath, { recursive: true })

    if (options?.repository) {
      this.validateRepository(options.repository)
      await this.ensureRepository(workspacePath, options.repository)
    }

    return {
      id: `ws:${userId}:${projectId}`,
      userId,
      projectId,
      path: workspacePath,
      status: 'active',
    }
  }

  private async ensureRepository(workspacePath: string, repository: string): Promise<void> {
    const gitDir = path.posix.join(workspacePath, '.git')
    const hasClone = await fs
      .stat(gitDir)
      .then((s) => s.isDirectory())
      .catch(() => false)

    if (hasClone) {
      // Atualização best-effort: um pull falho não pode derrubar a missão
      // (o agente ainda trabalha com o clone existente).
      try {
        await execFileAsync('git', ['-C', workspacePath, 'pull', '--ff-only'], {
          timeout: 120_000,
        })
      } catch {
        // Mantém o clone atual; a falha de rede/pull fica visível no git log da VM.
      }
      return
    }

    // Sem clone: falha aqui É falha de missão (workspace vazio geraria análise inútil).
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', `https://github.com/${repository}.git`, workspacePath],
      { timeout: 300_000 }
    )
  }

  async hibernateWorkspace(userId: string, projectId: string): Promise<void> {
    this.validateInput(userId)
    this.validateInput(projectId)
    // Sem MicroVM não há snapshot a tirar nem processo a matar.
  }
}
