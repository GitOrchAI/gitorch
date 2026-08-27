/**
 * Máquina de estados para perguntas estratégicas do PO (AgentQuestion) no Telegram.
 * Suporta rastreamento por questionId, modo "Vou digitar..." para acumular perguntas
 * sem colisão de contexto, e congelamento isolado de tarefas na Sprint.
 */

export interface PendingQuestionState {
  questionId: string
  userId: string
  chatId: string
  requestedAt: Date
}

export class AgentQuestionStateManager {
  private readonly typingUsers = new Map<string, PendingQuestionState>()
  private readonly frozenTasksByProject = new Map<string, Set<string>>()

  /**
   * Define que o usuário clicou em "✍️ Vou digitar..." para uma pergunta específica.
   * A próxima mensagem de texto deste usuário será associada a este questionId.
   */
  setActiveTypingQuestion(userId: string, state: Omit<PendingQuestionState, 'requestedAt'>): void {
    this.typingUsers.set(userId, {
      ...state,
      requestedAt: new Date(),
    })
  }

  /**
   * Obtém a pergunta ativa que o usuário está respondendo por texto livre.
   */
  getActiveTypingQuestion(userId: string): PendingQuestionState | null {
    return this.typingUsers.get(userId) ?? null
  }

  /**
   * Limpa o estado de digitação do usuário após a resposta ser processada.
   */
  clearActiveTypingQuestion(userId: string): void {
    this.typingUsers.delete(userId)
  }

  /**
   * Marca uma task como congelada devido a uma dúvida pendente de decisão de negócio.
   */
  freezeTask(projectId: string, taskId: string): void {
    let tasks = this.frozenTasksByProject.get(projectId)
    if (!tasks) {
      tasks = new Set<string>()
      this.frozenTasksByProject.set(projectId, tasks)
    }
    tasks.add(taskId)
  }

  /**
   * Descongela uma task após a resposta da pergunta.
   */
  unfreezeTask(projectId: string, taskId: string): void {
    const tasks = this.frozenTasksByProject.get(projectId)
    if (tasks) {
      tasks.delete(taskId)
    }
  }

  /**
   * Verifica se a task está congelada por dúvida de negócio.
   */
  isTaskFrozen(projectId: string, taskId: string): boolean {
    const tasks = this.frozenTasksByProject.get(projectId)
    return tasks ? tasks.has(taskId) : false
  }

  /**
   * Lista todas as tasks congeladas de um projeto.
   */
  getFrozenTasks(projectId: string): string[] {
    const tasks = this.frozenTasksByProject.get(projectId)
    return tasks ? Array.from(tasks) : []
  }
}

export const defaultAgentQuestionStateManager = new AgentQuestionStateManager()
