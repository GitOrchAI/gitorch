import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { LocalWorkspaceProvider } from '@gitorch/workspace-engine'

type PrismaLike = Pick<PrismaClient, 'clientEnvironment'>

// Só o que o serviço usa do provider — permite injetar um fake nos testes,
// sem git real.
type WorkspaceAllocator = Pick<LocalWorkspaceProvider, 'allocateWorkspace'>

export interface ClientEnvironmentRecord {
  id: string
  userId: string
  status: string
  path: string
  fixedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Gerencia o ciclo de vida do ambiente isolado de cada cliente no setup wizard.
 * O ambiente nasce 'provisional' no aceite dos termos, acumula o clone dos
 * repos e as credenciais de motor logadas dentro dele, e vira 'fixed' no aceite
 * final. Um garbage collector (à parte) destrói 'provisional' com mais de 24h.
 *
 * O diretório base é infra da VM: vem de GITORCH_ENVIRONMENTS_DIR (nunca
 * hardcoded fixo), mesmo padrão do LocalWorkspaceProvider. O `path` guardado
 * é interno — nunca deve ser exposto ao frontend.
 */
export class ClientEnvironmentService {
  private readonly baseDir: string
  private readonly provider: WorkspaceAllocator

  constructor(
    private readonly prisma: PrismaLike,
    baseDir = process.env['GITORCH_ENVIRONMENTS_DIR'] ?? '/var/lib/gitorch/environments',
    provider?: WorkspaceAllocator
  ) {
    this.baseDir = baseDir
    this.provider = provider ?? new LocalWorkspaceProvider(baseDir)
  }

  /**
   * Cria (ou reusa) o ambiente provisório do usuário. Idempotente: se já há um
   * 'provisional' aberto, devolve ele em vez de criar outro — recarregar o
   * wizard não pode multiplicar ambientes, pois cada um passa a guardar as
   * credenciais do cliente em disco. Cria um diretório 0700 exclusivo (só o
   * dono acessa), nomeado pelo id do registro.
   */
  async createProvisional(userId: string): Promise<ClientEnvironmentRecord> {
    const existing = await this.prisma.clientEnvironment.findFirst({
      where: { userId, status: 'provisional' },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) return existing as ClientEnvironmentRecord

    const created = await this.prisma.clientEnvironment.create({
      data: { userId, status: 'provisional', path: '' },
    })
    const dir = path.join(this.baseDir, created.id)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })

    const updated = await this.prisma.clientEnvironment.update({
      where: { id: created.id },
      data: { path: dir },
    })
    return updated as ClientEnvironmentRecord
  }

  /**
   * Clona os repositórios escolhidos DENTRO do ambiente do cliente (passo 4),
   * cada um num subdiretório do ambiente (nomeado pelo envId). Reusa o
   * LocalWorkspaceProvider, que autentica com o token do PRÓPRIO cliente por
   * invocação (nunca grava a credencial em disco/URL) e sanitiza erros de git.
   * Os clones ficam sob o diretório 0700 do ambiente, protegidos.
   */
  async cloneInto(
    envId: string,
    repos: string[],
    token?: string
  ): Promise<Array<{ repo: string; path: string }>> {
    const cloned: Array<{ repo: string; path: string }> = []
    for (const repo of repos) {
      // exactOptionalPropertyTypes: só inclui `token` quando existe (nunca
      // passa `undefined` explícito ao provider).
      const options = token !== undefined ? { repository: repo, token } : { repository: repo }
      const ws = await this.provider.allocateWorkspace(envId, repo, options)
      cloned.push({ repo, path: ws.path })
    }
    return cloned
  }
}
