import { describe, expect, it } from 'vitest'
import { AgentQuestionStateManager } from './agent-question-state.js'

describe('AgentQuestionStateManager', () => {
  it('gerencia o ciclo de digitação de resposta livre por usuário e questionId', () => {
    const manager = new AgentQuestionStateManager()
    expect(manager.getActiveTypingQuestion('user-1')).toBeNull()

    manager.setActiveTypingQuestion('user-1', {
      questionId: 'q-100',
      userId: 'user-1',
      chatId: 'chat-999',
    })

    const active = manager.getActiveTypingQuestion('user-1')
    expect(active).not.toBeNull()
    expect(active?.questionId).toBe('q-100')
    expect(active?.chatId).toBe('chat-999')
    expect(active?.requestedAt).toBeInstanceOf(Date)

    manager.clearActiveTypingQuestion('user-1')
    expect(manager.getActiveTypingQuestion('user-1')).toBeNull()
  })

  it('gerencia congelamento e descongelamento isolado de tasks por projeto', () => {
    const manager = new AgentQuestionStateManager()
    const projectId = 'proj-1'
    const taskId1 = 'task-auth'
    const taskId2 = 'task-billing'

    expect(manager.isTaskFrozen(projectId, taskId1)).toBe(false)
    expect(manager.getFrozenTasks(projectId)).toEqual([])

    manager.freezeTask(projectId, taskId1)
    expect(manager.isTaskFrozen(projectId, taskId1)).toBe(true)
    expect(manager.isTaskFrozen(projectId, taskId2)).toBe(false)
    expect(manager.getFrozenTasks(projectId)).toEqual(['task-auth'])

    manager.freezeTask(projectId, taskId2)
    expect(manager.getFrozenTasks(projectId)).toContain('task-auth')
    expect(manager.getFrozenTasks(projectId)).toContain('task-billing')

    manager.unfreezeTask(projectId, taskId1)
    expect(manager.isTaskFrozen(projectId, taskId1)).toBe(false)
    expect(manager.isTaskFrozen(projectId, taskId2)).toBe(true)
    expect(manager.getFrozenTasks(projectId)).toEqual(['task-billing'])
  })
})
