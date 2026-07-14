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

    // Corrida (dois aceites simultâneos): o canônico é sempre o MAIS RECENTE —
    // o mesmo critério do findFirst desc usado em todo o serviço, então clone
    // e login convergem pro mesmo ambiente. Se este create perdeu a corrida
    // (existe um mais novo), destrói o próprio e devolve o vencedor; um
    // perdedor que escapar desta janela continua 'provisional' e a faxina 24h
    // o destrói. O dedup definitivo acontece no fix() antes de fixar.
    const winner = await this.prisma.clientEnvironment.findFirst({
      where: { userId, status: 'provisional' },
      orderBy: { createdAt: 'desc' },
    })
    if (winner && winner.id !== updated.id) {
      await this.destroy(updated.id)
      return winner as ClientEnvironmentRecord
    }
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
      // O provider valida o projectId com /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/ —
      // que REJEITA a barra de "owner/repo". Passar o repo cru quebrava o
      // clone para QUALQUER repositório real (500 no /setup/clone), e os
      // testes não pegavam porque mockavam o provider. O slug sanitizado é o
      // MESMO esquema do repoPathInEnv (owner_repo) — os dois têm que andar
      // juntos, senão o diagnóstico não reencontra o clone.
      const slug = repo.replace(/[^a-zA-Z0-9_-]/g, '_')
      // exactOptionalPropertyTypes: só inclui `token` quando existe (nunca
      // passa `undefined` explícito ao provider).
      const options = token !== undefined ? { repository: repo, token } : { repository: repo }
      const ws = await this.provider.allocateWorkspace(envId, slug, options)
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
   * O ambiente ATUAL do usuário (o mais recente — mesmo critério `desc` que
   * createProvisional/fix usam para eleger o canônico), ou null se ele não tem
   * nenhum. Alimenta o status do provisionamento no fim do wizard: o cliente vê
   * o estado real do ambiente dele (provisional/fixed). Quem chama só pode
   * expor `id` e `status` — o `path` é infra e NUNCA vai pro frontend.
   */
  async current(userId: string): Promise<ClientEnvironmentRecord | null> {
    const env = await this.prisma.clientEnvironment.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    return (env as ClientEnvironmentRecord | null) ?? null
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
   * fora da raiz de ambientes. A ORDEM importa para SEGURANÇA: o registro do
   * banco é a ÚNICA forma do GC (listExpired varre linhas do banco) reencontrar
   * o dir; por isso só apaga o registro DEPOIS do dir sumir (rm OK, ou dir
   * inexistente — force:true resolve sem erro). Se o rm falhar (disco ocupado,
   * lock, permissão), preserva o registro e retorna: apagá-lo aqui deixaria a
   * credencial órfã em disco FORA do alcance da faxina. O GC retenta no tick
   * seguinte. Quando o guard barra a remoção (rel vazio/'..'/absoluto), não há
   * dir sob nossa gestão para orfanar, então o registro é removido.
   */
  async destroy(envId: string): Promise<void> {
    const env = await this.prisma.clientEnvironment.findUnique({ where: { id: envId } })
    if (env?.path) {
      // Contenção pelo idioma canônico de path.relative (mesma razão do
      // repoPathInEnv: é o que o CodeQL reconhece como sanitizador). Só apaga
      // ESTRITAMENTE DENTRO da raiz de ambientes: rel === '' (o próprio
      // baseDir — apagaria os ambientes de TODOS os clientes de uma vez),
      // '..' (fora) e absoluto (outro volume) são todos barrados.
      const resolved = path.resolve(env.path)
      const root = path.resolve(this.baseDir)
      const rel = path.relative(root, resolved)
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        try {
          await fs.rm(resolved, { recursive: true, force: true })
        } catch (err) {
          // rm falhou: NÃO deleta o registro. Deixa o GC reencontrar o dir
          // (com a credencial) pela linha do banco e retentar no próximo tick.
          console.warn(
            '[environment] destroy: rm do dir falhou, registro preservado para o GC retentar',
            { envId, error: err instanceof Error ? err.message : String(err) }
          )
          return
        }
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
    // Dedup ANTES de fixar: se uma corrida deixou >1 provisional, fixar todos
    // tornaria o duplicado (vazio, com credencial em disco) permanente e fora
    // do alcance da faxina 24h — lixo com segredo pra sempre. Mantém só o mais
    // recente (o canônico do findFirst desc, onde clone e login aconteceram) e
    // destrói os demais (dir + registro).
    const provisionals = await this.prisma.clientEnvironment.findMany({
      where: { userId, status: 'provisional' },
      orderBy: { createdAt: 'desc' },
    })
    for (const dupe of provisionals.slice(1)) {
      await this.destroy(dupe.id)
    }

    await this.prisma.clientEnvironment.updateMany({
      where: { userId, status: 'provisional' },
      data: { status: 'fixed', fixedAt: new Date() },
    })
  }
}
