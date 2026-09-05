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
  // FIX-UP L4-T27 (revisão, item 3): `avisoDoManipulador` é EFÊMERO em
  // `agent-question.ts` — nunca gravado no banco, só anexado no objeto que
  // `answer()` devolve na chamada que de fato rodou o manipulador
  // (`agent-question.ts answer()`: `if (existing.status === 'answered')
  // return existing` — a idempotência devolve o record CRU, sem recomputar
  // o aviso). Uma 2ª pressão no MESMO botão (`handleTelegramCallback`, ramo
  // `jaRespondidaAntesDesteClique`) chama `answer()` de novo e cai
  // exatamente nesse `return` cru — sem esta cache, o 2º colapso reescrevia
  // a mensagem SEM a ressalva que a 1ª resposta tinha mostrado, como se a
  // entrega ao dev tivesse sido normal.
  private readonly avisosPorQuestionId = new Map<string, string>()

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
   * FIX-UP L4-T27 (revisão, item 3): guarda o aviso EFÊMERO que o
   * manipulador de resposta devolveu na 1ª chamada de verdade a `answer()`
   * — para uma 2ª pressão no mesmo botão ainda achar a ressalva (ver
   * comentário do campo, acima).
   */
  setAvisoDoManipulador(questionId: string, aviso: string): void {
    this.avisosPorQuestionId.set(questionId, aviso)
  }

  /**
   * Lê o aviso guardado por `setAvisoDoManipulador` — `undefined` quando
   * nenhuma resposta anterior desta pergunta guardou um (caminho feliz
   * comum, ou processo reiniciado entre as duas pressões).
   */
  getAvisoDoManipulador(questionId: string): string | undefined {
    return this.avisosPorQuestionId.get(questionId)
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
