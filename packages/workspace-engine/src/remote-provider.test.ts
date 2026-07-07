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

  test('com token, autentica via header HTTP Basic por-invocação (nunca embutido na URL)', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/home/gitorch/missions')

    await provider.allocateWorkspace('user1', 'proj1', {
      repository: 'octocat/private-repo',
      token: 'gh_secret_token',
    })

    const script: string = runner.mock.calls[0][0].args[1]
    // Basic, NÃO Bearer: o endpoint smart-HTTP do git no GitHub rejeita
    // Bearer com "invalid credentials" mesmo com token válido — confirmado
    // ao vivo no QA da F1 (a API REST aceita Bearer; o git HTTP não).
    const expectedBasic = Buffer.from('x-access-token:gh_secret_token').toString('base64')
    expect(script).toContain(
      `git -c 'http.extraHeader=Authorization: Basic ${expectedBasic}' clone`
    )
    // Token cru nunca aparece em lugar nenhum do script (nem na URL, nem no header).
    expect(script).not.toContain('gh_secret_token@')
    expect(script).not.toContain('gh_secret_token')
  })

  test('token com aspa simples nunca quebra o shell — base64 não tem metacaractere de shell', async () => {
    const runner = vi.fn().mockResolvedValue(ok())
    const provider = new RemoteWorkspaceProvider(runner, '/base')
    const token = "x'; rm -rf /; echo '"

    await provider.allocateWorkspace('u', 'p', {
      repository: 'octocat/repo',
      token,
    })

    const script: string = runner.mock.calls[0][0].args[1]
    // Base64 do header Basic nunca contém aspa simples nem `;` — a
    // codificação em si já é imune a injeção, antes mesmo do shellQuote.
    const expectedBasic = Buffer.from(`x-access-token:${token}`).toString('base64')
    expect(script).toContain(expectedBasic)
    expect(script).not.toContain('rm -rf /')
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
