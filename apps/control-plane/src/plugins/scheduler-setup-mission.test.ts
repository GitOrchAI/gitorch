import { describe, expect, test, vi } from 'vitest'
import { provisionSetupMission, type RuntimeStack } from './scheduler.js'

function fakeStack(allocateWorkspace: ReturnType<typeof vi.fn>): RuntimeStack {
  return {
    // registry/orchestrator não são usados por provisionSetupMission — só o
    // workspaceProvider clona o repo. Double mínimo, mesma disciplina dos
    // outros testes desta sessão.
    registry: {} as RuntimeStack['registry'],
    orchestrator: {} as RuntimeStack['orchestrator'],
    workspaceProvider: {
      allocateWorkspace,
      hibernateWorkspace: vi.fn(),
    } as unknown as RuntimeStack['workspaceProvider'],
  }
}

describe('provisionSetupMission', () => {
  test('aloca o workspace do projeto e retorna completed em sucesso', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)

    const outcome = await provisionSetupMission(
      {
        id: 'mission_1',
        project: { id: 'proj_1', wingId: 'octocat/repo', userId: 'user_1' },
      },
      stack
    )

    expect(outcome.status).toBe('completed')
    expect(allocateWorkspace).toHaveBeenCalledWith('user_1', 'proj_1', {
      repository: 'octocat/repo',
    })
  })

  test('sem userId, usa o usuário genérico do scheduler (mesma convenção do dispatch clássico)', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)

    await provisionSetupMission(
      { id: 'mission_2', project: { id: 'proj_2', wingId: 'octocat/repo2', userId: null } },
      stack
    )

    expect(allocateWorkspace).toHaveBeenCalledWith('scheduler-user', 'proj_2', {
      repository: 'octocat/repo2',
    })
  })

  test('repassa o token do GitHub do dono do projeto para clonar repo privado', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)

    await provisionSetupMission(
      { id: 'mission_4', project: { id: 'proj_4', wingId: 'octocat/private', userId: 'user_1' } },
      stack,
      'gh_owner_token'
    )

    expect(allocateWorkspace).toHaveBeenCalledWith('user_1', 'proj_4', {
      repository: 'octocat/private',
      token: 'gh_owner_token',
    })
  })

  test('retorna failed com a causa real quando o clone falha (nunca mascara)', async () => {
    const allocateWorkspace = vi.fn().mockRejectedValue(new Error('workspace remoto falhou'))
    const stack = fakeStack(allocateWorkspace)

    const outcome = await provisionSetupMission(
      { id: 'mission_3', project: { id: 'proj_3', wingId: 'octocat/repo3', userId: 'user_1' } },
      stack
    )

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('workspace remoto falhou')
  })
})
