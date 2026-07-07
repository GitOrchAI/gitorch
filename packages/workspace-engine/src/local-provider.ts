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

/** Executa `git <args>`. Injetável para teste (evita rede real nos testes). */
export type GitRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>

const defaultGitRunner =
  (timeoutMs: number): GitRunner =>
  (args: string[]) =>
    execFileAsync('git', args, { timeout: timeoutMs })

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
  private gitRunner?: GitRunner

  constructor(baseDir = '/var/lib/gitorch/workspaces', gitRunner?: GitRunner) {
    this.baseDir = baseDir
    this.gitRunner = gitRunner
  }

  /**
   * Prefixo `-c http.extraHeader=...` quando há token: autentica SÓ esta
   * invocação do git — nunca grava a credencial em `.git/config` nem na URL
   * remota (onde vazaria por `git remote -v`/logs). Repositório privado usa o
   * token do PRÓPRIO cliente (spec setup-wizard-redesign §17.3).
   *
   * Basic, NÃO Bearer: o endpoint smart-HTTP do git no GitHub rejeita
   * `Authorization: Bearer <token>` com "invalid credentials" mesmo com um
   * token válido (confirmado ao vivo: o MESMO token autentica normal na API
   * REST via Bearer, mas falha no clone) — a API REST aceita Bearer, o git
   * HTTP não. `x-access-token` é o usuário-placeholder que o próprio GitHub
   * usa nesse esquema; a senha é o token.
   */
  private authArgs(token?: string): string[] {
    if (!token) return []
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
  }

  /**
   * O Node embute a linha de comando INTEIRA em ExecException.message
   * ("Command failed: git -c http.extraHeader=Authorization: Bearer <token>
   * ..."). Sem isto, uma falha de clone vaza o token do cliente em texto
   * puro pra onde o erro for parar (banco, resposta de API, log de missão) —
   * achado real do QA da F1 (diagnóstico grátis), corrigido na origem porque
   * afeta TODO consumidor deste provider, não só o diagnóstico.
   */
  private sanitizeGitError(err: unknown, token?: string): Error {
    let message = err instanceof Error ? err.message : String(err)
    if (token) message = message.split(token).join('[REDACTED]')
    // Defesa em profundidade: authArgs manda Basic base64("x-access-token:"+
    // token), que NÃO contém o token cru como substring — o split acima não
    // pega esse formato. Redige qualquer "Authorization: <esquema> <valor>"
    // que sobrar, não importa a codificação.
    message = message.replace(/Authorization:\s*\S+\s+\S+/gi, 'Authorization: [REDACTED]')
    return new Error(message)
  }

  private validateInput(value: string): void {
    // Rejeita hífen inicial: um id como "-foo" viraria flag se algum dia
    // fluir para uma linha de comando sem barreira `--`.
    const regex = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/
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
    options?: { repository?: string; token?: string }
  ): Promise<LocalWorkspaceInfo> {
    this.validateInput(userId)
    this.validateInput(projectId)

    const workspacePath = path.posix.join(this.baseDir, userId, projectId)
    await fs.mkdir(workspacePath, { recursive: true })

    if (options?.repository) {
      this.validateRepository(options.repository)
      await this.ensureRepository(workspacePath, options.repository, options.token)
    }

    return {
      id: `ws:${userId}:${projectId}`,
      userId,
      projectId,
      path: workspacePath,
      status: 'active',
    }
  }

  private async ensureRepository(
    workspacePath: string,
    repository: string,
    token?: string
  ): Promise<void> {
    const run = this.gitRunner ?? defaultGitRunner(300_000)
    const auth = this.authArgs(token)

    const resolvedWorkspace = path.posix.resolve(workspacePath)
    const gitDir = path.posix.join(resolvedWorkspace, '.git')
    const resolvedGitDir = path.posix.resolve(gitDir)

    if (!resolvedGitDir.startsWith(resolvedWorkspace + path.posix.sep)) {
      return
    }

    const hasClone = await fs
      .stat(resolvedGitDir)
      .then((s) => s.isDirectory())
      .catch(() => false)

    if (hasClone) {
      // Atualização best-effort: um pull falho não pode derrubar a missão
      // (o agente ainda trabalha com o clone existente), mas NÃO fica silencioso.
      try {
        await run([...auth, '-C', workspacePath, 'pull', '--ff-only'])
      } catch (err) {
        // Histórico divergiu (força-push, clone raso antigo): o workspace é um
        // clone descartável de LEITURA — alinhar à força com o remoto é o
        // comportamento certo. O fetch do pull falho já atualizou as refs
        // remotas; o reset usa o upstream do branch atual.
        try {
          await run(['-C', workspacePath, 'reset', '--hard', '@{u}'])
        } catch {
          // Sinaliza staleness em stderr do serviço: sem isso, análises rodariam
          // sobre código velho parecendo atuais. `err` é o erro do PULL (que
          // usou `auth`) — sanitiza antes de logar.
          // eslint-disable-next-line no-console
          console.warn(
            `[workspace] git pull e reset falharam em ${repository}; usando clone existente (possivelmente desatualizado): ${this.sanitizeGitError(err, token).message}`
          )
        }
      }
      return
    }

    // Sem clone: falha aqui É falha de missão (workspace vazio geraria análise inútil).
    // Com token, autentica via header por-invocação (repo privado do cliente);
    // sem token, clona anonimamente (repo público).
    // `--` encerra as opções do git: mesmo que `repository` (validado) fluísse
    // como algo parecido com flag, nada depois de `--` é interpretado como
    // opção (defesa contra injeção de argumento de segunda ordem, ex.:
    // `--upload-pack`). A URL é prefixada e o repositório passou pela regex.
    try {
      await run([
        ...auth,
        'clone',
        '--depth',
        '1',
        '--',
        `https://github.com/${repository}.git`,
        workspacePath,
      ])
    } catch (err) {
      throw this.sanitizeGitError(err, token)
    }
  }

  async hibernateWorkspace(userId: string, projectId: string): Promise<void> {
    this.validateInput(userId)
    this.validateInput(projectId)
    // Sem MicroVM não há snapshot a tirar nem processo a matar.
  }
}
