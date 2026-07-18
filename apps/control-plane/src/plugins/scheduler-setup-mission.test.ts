import { describe, expect, test, vi } from 'vitest'
import {
  provisionSetupMission,
  selectClaimableSetupMissions,
  type RuntimeStack,
} from './scheduler.js'

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

// O teto de concorrência (MAX_CONCURRENT_MISSIONS) passa a cobrir TAMBÉM o
// wizard, não só a cadência (spec Onda 2 / F1.1.6). processSetupMissions usa
// esta função pura para decidir o que cabe nesta rodada; a fiação com o
// Prisma (contagem real de pending+running) fica no plugin, não aqui.
describe('selectClaimableSetupMissions', () => {
  test('teto=1 e 1 missão já rodando (fora deste lote): a 2ª setup mission pendente fica na fila', () => {
    const pendingFifo = [{ id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, /* otherActiveCount */ 1, 1)

    expect(claimable).toEqual([])
  })

  test('sem nada mais ativo e teto=2, as 2 primeiras pendentes (FIFO) são reivindicadas; a 3ª fica na fila', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }, { id: 'setup_3' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 0, 2)

    expect(claimable.map((m) => m.id)).toEqual(['setup_1', 'setup_2'])
  })

  test('1 outra ativa e teto=2: só a mais antiga da fila é reivindicada', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 1, 2)

    expect(claimable.map((m) => m.id)).toEqual(['setup_1'])
  })

  test('capacidade sobrando (teto alto): todas as pendentes são reivindicadas', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 0, 5)

    expect(claimable.map((m) => m.id)).toEqual(['setup_1', 'setup_2'])
  })

  test('sem capacidade nenhuma (outras ativas já no teto): fila inteira espera', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 3, 2)

    expect(claimable).toEqual([])
  })

  test('fila vazia: nada a reivindicar, sem tocar no teto', () => {
    expect(selectClaimableSetupMissions([], 0, 1)).toEqual([])
  })
})
