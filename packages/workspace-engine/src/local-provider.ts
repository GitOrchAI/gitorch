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

  constructor(
    baseDir = process.env['GITORCH_WORKSPACES_DIR'] ?? '/var/lib/gitorch/workspaces',
    gitRunner?: GitRunner
  ) {
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
   * Um token que autentica a API REST (Bearer) pode não servir pro smart-HTTP
   * do git (Basic) — ou pode estar simplesmente inválido/expirado/sem escopo.
   * Nesses casos o clone falha mesmo para um repositório PÚBLICO, que
   * clonaria normalmente sem credencial nenhuma. Detecta essa classe de erro
   * pela mensagem (case-insensitive) pra decidir se vale a pena retentar sem
   * auth — um erro de outra natureza (repo inexistente, rede) não deve
   * mascarar-se como sucesso possível numa segunda tentativa.
   */
  private isAuthError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    const patterns = [
      'authentication failed',
      'invalid username or token',
      'could not read username',
      'terminal prompts disabled',
    ]
    const lower = message.toLowerCase()
    return patterns.some((p) => lower.includes(p))
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
    const sanitized = new Error(message)
    // Preserva o sinal de ESTOURO DE PRAZO do child_process (killed/signal):
    // quando o `timeout` do execFile mata o processo, a MENSAGEM não diz
    // "timeout" em lugar nenhum (fica só "Command failed: <cmd>\n" — o Node
    // não anota a causa em texto). Sem repassar essas duas propriedades pro
    // Error sanitizado, quem consome este erro (classifyCloneError no
    // control-plane) não tem como diferenciar um clone que estourou o prazo
    // de qualquer outra falha genérica.
    const original = err as { killed?: boolean; signal?: NodeJS.Signals | null } | null
    if (original && (original.killed === true || original.signal)) {
      Object.assign(sanitized, {
        killed: original.killed,
        ...(original.signal ? { signal: original.signal } : {}),
      })
    }
    return sanitized
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

    // Sanitiza os valores de entrada
    const sanitizedUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_')

    // Constrói o caminho absoluto e garante que ele permaneça dentro de this.baseDir
    const workspacePath = path.resolve(this.baseDir, sanitizedUserId, sanitizedProjectId)
    if (!workspacePath.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Caminho fora da raiz permitida')
    }

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
    const cloneArgs = (extraAuth: string[]) => [
      ...extraAuth,
      'clone',
      '--depth',
      '1',
      '--',
      `https://github.com/${repository}.git`,
      workspacePath,
    ]

    try {
      await run(cloneArgs(auth))
    } catch (err) {
      // Repositório público bloqueado por um token ruim (inválido, expirado,
      // sem escopo pra git — comprovado ao vivo com o OAuth token do dono,
      // que autentica a API REST mas não o smart-HTTP do git): retenta
      // ANÔNIMO, sem a credencial que causou a falha. Um repo privado sem
      // token válido continua falhando na segunda tentativa (comportamento
      // correto). Erro de outra natureza (repo não existe, rede) não retenta.
      if (token && this.isAuthError(err)) {
        try {
          await run(cloneArgs([]))
          return
        } catch (retryErr) {
          throw this.sanitizeGitError(retryErr, token)
        }
      }
      throw this.sanitizeGitError(err, token)
    }
  }

  async hibernateWorkspace(userId: string, projectId: string): Promise<void> {
    this.validateInput(userId)
    this.validateInput(projectId)
    // Sem MicroVM não há snapshot a tirar nem processo a matar.
  }
}
