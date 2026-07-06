import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'
import { LocalWorkspaceProvider } from './local-provider'

test('allocates a plain directory workspace and hibernates as a no-op', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const provider = new LocalWorkspaceProvider(base)

  const info = await provider.allocateWorkspace('scheduler-user', 'project-1')

  expect(info.path).toBe(path.posix.join(base, 'scheduler-user', 'project-1'))
  expect(info.status).toBe('active')
  const stat = await fs.stat(info.path)
  expect(stat.isDirectory()).toBe(true)

  await expect(provider.hibernateWorkspace('scheduler-user', 'project-1')).resolves.toBeUndefined()
  await fs.rm(base, { recursive: true, force: true })
})

test('rejects path-traversal attempts in user and project ids', async () => {
  const provider = new LocalWorkspaceProvider('/tmp/gitorch-local-ws-never')
  await expect(provider.allocateWorkspace('../evil', 'project')).rejects.toThrow('Entrada inválida')
  await expect(provider.allocateWorkspace('user', 'a/b')).rejects.toThrow('Entrada inválida')
})

test('rejects leading-dash ids that could be read as command flags', async () => {
  const provider = new LocalWorkspaceProvider('/tmp/gitorch-local-ws-never')
  await expect(provider.allocateWorkspace('-rf', 'project')).rejects.toThrow('Entrada inválida')
  await expect(provider.allocateWorkspace('user', '-x')).rejects.toThrow('Entrada inválida')
})

test('rejects repositories that are not a safe owner/repo slug', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const provider = new LocalWorkspaceProvider(base)
  for (const bad of [
    '--upload-pack=touch /tmp/x',
    '-evil/repo',
    'owner/repo; rm -rf /',
    'owner repo/x',
    'https://evil.com/repo',
    'owner/repo.git ext::sh',
  ]) {
    await expect(
      provider.allocateWorkspace('scheduler-user', 'project-1', { repository: bad })
    ).rejects.toThrow('Repositório inválido')
  }
  await fs.rm(base, { recursive: true, force: true })
})

test('clona repo privado autenticando via header HTTP (nunca grava o token em disco)', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const gitRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  await provider.allocateWorkspace('scheduler-user', 'project-1', {
    repository: 'octocat/private-repo',
    token: 'gh_secret_token',
  })

  const [args] = gitRunner.mock.calls[0] as [string[]]
  expect(args).toContain('clone')
  // O token viaja num header por-invocação (-c http.extraHeader), nunca
  // embutido na URL (que iria pro .git/config em texto puro).
  const headerIdx = args.indexOf('-c')
  expect(headerIdx).toBeGreaterThanOrEqual(0)
  expect(args[headerIdx + 1]).toBe('http.extraHeader=Authorization: Bearer gh_secret_token')
  expect(args.join(' ')).not.toContain('gh_secret_token@')

  await fs.rm(base, { recursive: true, force: true })
})

test('clona repo público sem header quando nenhum token é passado', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const gitRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  await provider.allocateWorkspace('scheduler-user', 'project-1', {
    repository: 'octocat/public-repo',
  })

  const [args] = gitRunner.mock.calls[0] as [string[]]
  expect(args).not.toContain('-c')

  await fs.rm(base, { recursive: true, force: true })
})
