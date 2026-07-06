import { describe, expect, test, vi } from 'vitest'
import { RemoteWorkspaceProvider } from './remote-provider.js'

function ok(stdout = '') {
  return { exitCode: 0, stdout, stderr: '' }
}

describe('RemoteWorkspaceProvider', () => {
  test('aloca diretório remoto e clona o repositório via runner remoto', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/home/gitorch/missions')

    const info = await provider.allocateWorkspace('user1', 'proj1', {
      repository: 'octocat/Hello-World',
    })

    expect(info.path).toBe('/home/gitorch/missions/user1/proj1/ws')
    expect(info.status).toBe('active')
    const call = runner.mock.calls[0][0]
    expect(call.binary).toBe('sh')
    expect(call.args[0]).toBe('-c')
    const script: string = call.args[1]
    expect(script).toContain('mkdir -p /home/gitorch/missions/user1/proj1/ws')
    expect(script).toContain('git clone --depth 1 -- https://github.com/octocat/Hello-World.git')
  })

  test('sem repositório, só cria o diretório (não clona)', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/base')

    await provider.allocateWorkspace('u', 'p')

    const script: string = runner.mock.calls[0][0].args[1]
    expect(script).toContain('mkdir -p /base/u/p/ws')
    expect(script).not.toContain('git clone')
  })

  test('propaga falha do runner remoto como falha de missão', async () => {
    const runner = vi
      .fn()
      .mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'fatal: repo não existe' })
    const provider = new RemoteWorkspaceProvider(runner, '/base')

    await expect(provider.allocateWorkspace('u', 'p', { repository: 'x/y' })).rejects.toThrow(
      /workspace remoto/i
    )
  })

  test('rejeita userId/projectId com metacaracteres (defesa contra injeção)', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/base')

    await expect(provider.allocateWorkspace('u; rm -rf /', 'p')).rejects.toThrow(/inválida/i)
    await expect(provider.allocateWorkspace('u', '../escape')).rejects.toThrow(/inválida/i)
    expect(runner).not.toHaveBeenCalled()
  })

  test('rejeita repositório fora do formato owner/repo', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/base')

    await expect(
      provider.allocateWorkspace('u', 'p', { repository: 'https://evil.com/x' })
    ).rejects.toThrow(/reposit/i)
    expect(runner).not.toHaveBeenCalled()
  })

  test('hibernateWorkspace remove o workspace remoto (missão descartável)', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/base')

    await provider.hibernateWorkspace('u', 'p')

    const script: string = runner.mock.calls[0][0].args[1]
    expect(script).toContain('rm -rf /base/u/p')
  })
})
