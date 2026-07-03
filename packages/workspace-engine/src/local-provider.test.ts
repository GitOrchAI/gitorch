import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
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
