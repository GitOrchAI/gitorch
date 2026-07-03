import * as fs from 'node:fs/promises'
import * as path from 'node:path'

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

  async allocateWorkspace(userId: string, projectId: string): Promise<LocalWorkspaceInfo> {
    this.validateInput(userId)
    this.validateInput(projectId)

    const workspacePath = path.posix.join(this.baseDir, userId, projectId)
    await fs.mkdir(workspacePath, { recursive: true })

    return {
      id: `ws:${userId}:${projectId}`,
      userId,
      projectId,
      path: workspacePath,
      status: 'active',
    }
  }

  async hibernateWorkspace(userId: string, projectId: string): Promise<void> {
    this.validateInput(userId)
    this.validateInput(projectId)
    // Sem MicroVM não há snapshot a tirar nem processo a matar.
  }
}
