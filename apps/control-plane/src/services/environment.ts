import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PrismaClient } from '@prisma/client'

type PrismaLike = Pick<PrismaClient, 'clientEnvironment'>

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

  constructor(
    private readonly prisma: PrismaLike,
    baseDir = process.env['GITORCH_ENVIRONMENTS_DIR'] ?? '/var/lib/gitorch/environments'
  ) {
    this.baseDir = baseDir
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
}
