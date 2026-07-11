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

  /**
   * Caminho do clone de um repo DENTRO do ambiente provisório do usuário —
   * mesmo esquema de path do cloneInto. Retorna null se não há ambiente ou o
   * repo ainda não foi clonado. Serve pro diagnóstico reaproveitar o clone do
   * passo 4 em vez de clonar de novo (não clonar 2x).
   */
  async repoPathInEnv(userId: string, repo: string): Promise<string | null> {
    try {
      const env = await this.prisma.clientEnvironment.findFirst({
        where: { userId, status: 'provisional' },
        orderBy: { createdAt: 'desc' },
      })
      if (!env?.path) return null
      const sanitized = repo.replace(/[^a-zA-Z0-9_-]/g, '_')
      const dir = path.join(env.path, sanitized)
      // Guard de contenção (idioma canônico via path.relative, o que o CodeQL
      // reconhece de forma confiável como sanitizador de path traversal — um
      // startsWith manual NÃO fechou o alerta numa 1a tentativa): `repo` é
      // input do cliente (nome de repositório escolhido no wizard). O replace
      // acima já elimina barras/pontos, mas isto é defesa em profundidade —
      // se `dir` escapar de env.path por QUALQUER via, `relative` começa com
      // '..' ou vira absoluto, e o guard barra antes do fs.stat.
      const resolvedEnvPath = path.resolve(env.path)
      const resolvedDir = path.resolve(dir)
      const relativeToEnv = path.relative(resolvedEnvPath, resolvedDir)
      if (relativeToEnv.startsWith('..') || path.isAbsolute(relativeToEnv)) {
        return null
      }
      const cloned = await fs
        .stat(path.join(resolvedEnvPath, relativeToEnv, '.git'))
        .then((s) => s.isDirectory())
        .catch(() => false)
      return cloned ? resolvedDir : null
    } catch {
      // Reuso é otimização best-effort: se o lookup do ambiente falhar, o
      // diagnóstico cai no clone próprio (diag-<repo>) — nunca quebra o fluxo.
      return null
    }
  }

  /**
   * Ambientes provisórios (não-fixados) com mais de `maxAgeMs`. Alimenta o
   * garbage collector: um ambiente abandonado guarda credenciais + OAuth do
   * cliente e não pode ficar largado — a faxina é requisito de SEGURANÇA.
   */
  async listExpired(
    maxAgeMs: number,
    now: number = Date.now()
  ): Promise<ClientEnvironmentRecord[]> {
    const cutoff = new Date(now - maxAgeMs)
    const rows = await this.prisma.clientEnvironment.findMany({
      where: { status: 'provisional', createdAt: { lt: cutoff } },
    })
    return rows as ClientEnvironmentRecord[]
  }

  /**
   * Destrói um ambiente: apaga o diretório em disco (com as credenciais) e o
   * registro. O rm é contido ao baseDir (guard de path-traversal) — nunca apaga
   * fora da raiz de ambientes. Best-effort em cada passo: uma falha no disco não
   * impede remover o registro, e vice-versa.
   */
  async destroy(envId: string): Promise<void> {
    const env = await this.prisma.clientEnvironment.findUnique({ where: { id: envId } })
    if (env?.path) {
      const resolved = path.resolve(env.path)
      const root = path.resolve(this.baseDir)
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        await fs.rm(resolved, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    await this.prisma.clientEnvironment.delete({ where: { id: envId } }).catch(() => undefined)
  }

  /**
   * Fixa o ambiente provisório do usuário no aceite final (passo 10): vira
   * 'fixed' (permanente) e sai do alcance da faxina 24h — agora é um cliente.
   * Idempotente: updateMany não falha se não houver provisional.
   */
  async fix(userId: string): Promise<void> {
    await this.prisma.clientEnvironment.updateMany({
      where: { userId, status: 'provisional' },
      data: { status: 'fixed', fixedAt: new Date() },
    })
  }
}
