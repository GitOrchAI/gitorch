/**
 * Runner que executa um comando numa máquina remota (ex.: via SSH). Compatível
 * estruturalmente com o RuntimeCommandRunner do pacote agents, mas definido aqui
 * para não acoplar workspace-engine a agents.
 */
export interface RemoteCommandRunner {
  (cmd: {
    binary: string
    args: string[]
    env: Record<string, string>
    timeoutMs?: number
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export interface RemoteWorkspaceInfo {
  id: string
  userId: string
  projectId: string
  /** Caminho ABSOLUTO do workspace NA máquina remota (montado em /workspace). */
  path: string
  status: 'active' | 'hibernated'
}

/**
 * Provedor de workspace REMOTO: clona o repositório da missão numa outra máquina
 * (ex.: MT-SaaS, para clientes de tier grátis) através de um runner remoto (SSH).
 *
 * O clone acontece NO nó remoto porque é lá que o container da missão roda — o
 * bind-mount do podman precisa de um caminho que exista na máquina de execução.
 * O deliverable da missão volta pelo stdout do próprio runner remoto, então não
 * há cópia de arquivos de volta. Espelha a validação de entrada do
 * LocalWorkspaceProvider: ids e repositório passam por regex antes de tocarem o
 * shell remoto (defesa contra injeção de argumento/comando).
 */
export class RemoteWorkspaceProvider {
  private runner: RemoteCommandRunner
  private baseDir: string

  constructor(runner: RemoteCommandRunner, baseDir = '/home/gitorch/missions') {
    this.runner = runner
    this.baseDir = baseDir
  }

  private validateInput(value: string): void {
    // Rejeita hífen inicial e qualquer metacaractere: só letras/números/_/-.
    const regex = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/
    if (!regex.test(value)) {
      throw new Error(
        `Entrada inválida detectada: "${value}". Apenas letras, números, hifens e underscores são permitidos.`
      )
    }
  }

  private validateRepository(repository: string): void {
    const regex = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/
    if (!regex.test(repository) || repository.startsWith('-')) {
      throw new Error(`Repositório inválido: "${repository}". Esperado formato owner/repo.`)
    }
  }

  private projectDir(userId: string, projectId: string): string {
    return `${this.baseDir}/${userId}/${projectId}`
  }

  /**
   * Quota um valor para o shell POSIX remoto usando aspas simples; a própria
   * aspa simples vira a sequência `'\''` (fecha, aspa escapada, reabre) — o
   * token nunca escapa do literal mesmo se contiver metacaracteres de shell.
   */
  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }

  async allocateWorkspace(
    userId: string,
    projectId: string,
    options?: { repository?: string; token?: string }
  ): Promise<RemoteWorkspaceInfo> {
    this.validateInput(userId)
    this.validateInput(projectId)

    const workspacePath = `${this.projectDir(userId, projectId)}/ws`
    let script = `mkdir -p ${workspacePath}`

    if (options?.repository) {
      this.validateRepository(options.repository)
      const url = `https://github.com/${options.repository}.git`
      // Token autentica via header POR-INVOCAÇÃO (-c http.extraHeader) — nunca
      // embutido na URL remota, onde vazaria por `git remote -v`/logs no nó
      // compartilhado. Repositório privado usa o token do PRÓPRIO cliente.
      const auth = options.token
        ? `-c ${this.shellQuote(`http.extraHeader=Authorization: Bearer ${options.token}`)} `
        : ''
      // Clone raso se ausente; se já existe, pull best-effort (clone é descartável
      // de LEITURA). `--` encerra as opções do git contra injeção de segunda ordem.
      script +=
        ` && if [ -d ${workspacePath}/.git ]; then` +
        ` git ${auth}-C ${workspacePath} pull --ff-only || true;` +
        ` else git ${auth}clone --depth 1 -- ${url} ${workspacePath}; fi`
    }

    const result = await this.runner({
      binary: 'sh',
      args: ['-c', script],
      env: {},
      timeoutMs: 300_000,
    })

    if (result.exitCode !== 0) {
      throw new Error(
        `workspace remoto falhou (exit ${result.exitCode}) para ${userId}/${projectId}: ${result.stderr.trim()}`
      )
    }

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
    // Missão grátis é descartável: remove o workspace remoto para não acumular
    // clones no disco do nó. Best-effort — uma falha aqui não derruba nada.
    const dir = this.projectDir(userId, projectId)
    await this.runner({ binary: 'sh', args: ['-c', `rm -rf ${dir}`], env: {} }).catch(
      () => undefined
    )
  }
}
