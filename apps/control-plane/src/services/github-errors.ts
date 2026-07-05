/**
 * Erro de execução no GitHub: NÃO é falha de motor — nunca aciona failover.
 * Vive em módulo próprio para os serviços de GitHub (backlog, board, QA, SM)
 * compartilharem sem import circular.
 */
export class GithubExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubExecutionError'
  }
}
