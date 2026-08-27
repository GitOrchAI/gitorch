import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'
import { LocalWorkspaceProvider } from './local-provider'

test('allocates a plain directory workspace and hibernates as a no-op', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const provider = new LocalWorkspaceProvider(base)

  const info = await provider.allocateWorkspace('scheduler-user', 'project-1')

  expect(info.path).toBe(path.resolve(base, 'scheduler-user', 'project-1'))
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
  // Basic (usuário x-access-token + token como senha), NÃO Bearer: o
  // endpoint HTTP de git do GitHub rejeita Bearer com "invalid credentials"
  // mesmo em token válido — confirmado ao vivo no QA da F1 (a API REST
  // aceita Bearer; o smart-HTTP do git exige Basic). Erro reproduzido fora
  // do código e comparado lado a lado antes desta correção.
  const expectedBasic = `Basic ${Buffer.from('x-access-token:gh_secret_token').toString('base64')}`
  expect(args[headerIdx + 1]).toBe(`http.extraHeader=Authorization: ${expectedBasic}`)
  expect(args.join(' ')).not.toContain('gh_secret_token@')

  await fs.rm(base, { recursive: true, force: true })
})

test('falha de clone NUNCA vaza o token: erro do git (que embute o comando inteiro) é redigido antes de propagar', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const token = 'gh_secret_token_abc123'
  // Reproduz o formato real do Node: ExecException.message inclui o comando
  // INTEIRO ("Command failed: git -c http.extraHeader=Authorization: Bearer
  // <token> clone ..."), exatamente o que vazou no QA real da F1.
  const gitRunner = vi
    .fn()
    .mockRejectedValue(
      new Error(
        `Command failed: git -c http.extraHeader=Authorization: Bearer ${token} clone --depth 1 -- https://github.com/octocat/private-repo.git ${base}/scheduler-user/project-1\nfatal: Authentication failed`
      )
    )
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  await expect(
    provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/private-repo',
      token,
    })
  ).rejects.toThrow()

  try {
    await provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/private-repo',
      token,
    })
  } catch (err) {
    const message = (err as Error).message
    expect(message).not.toContain(token)
    expect(message).toContain('[REDACTED]')
  }

  await fs.rm(base, { recursive: true, force: true })
})

test('redação também cobre o header Basic (base64) — não só o token cru', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const token = 'gh_secret_token_abc123'
  // O header REAL usado pra clone (Basic, ver authArgs) NÃO contém o token
  // como substring literal — é base64("x-access-token:"+token). Uma redação
  // que só faz message.split(token) NÃO pega isso: precisa reconhecer o
  // padrão "Authorization: Basic <blob>" também.
  const basicBlob = Buffer.from(`x-access-token:${token}`).toString('base64')
  const gitRunner = vi
    .fn()
    .mockRejectedValue(
      new Error(
        `Command failed: git -c http.extraHeader=Authorization: Basic ${basicBlob} clone --depth 1 -- https://github.com/octocat/private-repo.git ${base}/scheduler-user/project-1\nfatal: Authentication failed`
      )
    )
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  try {
    await provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/private-repo',
      token,
    })
    throw new Error('deveria ter lançado')
  } catch (err) {
    const message = (err as Error).message
    expect(message).not.toContain(token)
    expect(message).not.toContain(basicBlob)
    expect(message).toContain('[REDACTED]')
  }

  await fs.rm(base, { recursive: true, force: true })
})

test('fallback anônimo: clone com token falha por auth -> retenta sem header e sucede', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const token = 'gh_secret_token_fallback'
  const gitRunner = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        `Command failed: git -c http.extraHeader=Authorization: Basic xxx clone --depth 1 -- https://github.com/octocat/public-repo.git ${base}/scheduler-user/project-1\nfatal: Authentication failed`
      )
    )
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  await expect(
    provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/public-repo',
      token,
    })
  ).resolves.toMatchObject({ status: 'active' })

  expect(gitRunner).toHaveBeenCalledTimes(2)
  const [firstArgs] = gitRunner.mock.calls[0] as [string[]]
  const [secondArgs] = gitRunner.mock.calls[1] as [string[]]
  expect(firstArgs).toContain('-c')
  expect(secondArgs).not.toContain('-c')
  expect(secondArgs).toContain('clone')

  await fs.rm(base, { recursive: true, force: true })
})

test('erro não-auth (ex: repositório não encontrado) NÃO retenta e propaga', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const token = 'gh_secret_token_notfound'
  const gitRunner = vi
    .fn()
    .mockRejectedValue(
      new Error(
        `Command failed: git -c http.extraHeader=Authorization: Basic xxx clone --depth 1 -- https://github.com/octocat/missing-repo.git ${base}/scheduler-user/project-1\nfatal: repository 'https://github.com/octocat/missing-repo.git/' not found`
      )
    )
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  await expect(
    provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/missing-repo',
      token,
    })
  ).rejects.toThrow()

  expect(gitRunner).toHaveBeenCalledTimes(1)

  await fs.rm(base, { recursive: true, force: true })
})

test('fallback anônimo também falha por auth -> lança erro sanitizado (sem token) após 2 tentativas', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const token = 'gh_secret_token_bothfail'
  const gitRunner = vi
    .fn()
    .mockRejectedValue(
      new Error(
        `Command failed: git -c http.extraHeader=Authorization: Basic xxx clone --depth 1 -- https://github.com/octocat/private-repo.git ${base}/scheduler-user/project-1\nfatal: Invalid username or token. Password authentication is not supported`
      )
    )
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  try {
    await provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/private-repo',
      token,
    })
    throw new Error('deveria ter lançado')
  } catch (err) {
    const message = (err as Error).message
    expect(message).not.toContain(token)
  }

  expect(gitRunner).toHaveBeenCalledTimes(2)

  await fs.rm(base, { recursive: true, force: true })
})

test('estouro de prazo (timeout do execFile): killed/signal sobrevivem à sanitização do erro', async () => {
  // O Node NÃO escreve "timeout" na mensagem quando mata o processo por
  // estouro de prazo — só `killed`/`signal` denunciam (confirmado
  // experimentalmente com execFile+timeout curto: a mensagem fica só
  // "Command failed: <cmd>\n", sem stderr nenhum se o kill aconteceu antes
  // do git escrever algo). Sem preservar essas duas propriedades,
  // classifyCloneError (control-plane) não tem como distinguir um clone que
  // estourou o prazo de qualquer outra falha genérica — e o cliente veria
  // "algo deu errado" em vez de "está demorando demais".
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const gitRunner = vi.fn().mockRejectedValue(
    Object.assign(new Error('Command failed: git clone --depth 1 -- ... \n'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
    })
  )
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  try {
    await provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/slow-repo',
    })
    throw new Error('deveria ter lançado')
  } catch (err) {
    expect((err as Error & { killed?: boolean; signal?: string }).killed).toBe(true)
    expect((err as Error & { killed?: boolean; signal?: string }).signal).toBe('SIGTERM')
  }

  await fs.rm(base, { recursive: true, force: true })
})

test('erro sem killed/signal (falha comum) não ganha essas propriedades por engano', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-local-ws-'))
  const gitRunner = vi.fn().mockRejectedValue(new Error('fatal: repository not found'))
  const provider = new LocalWorkspaceProvider(base, gitRunner)

  try {
    await provider.allocateWorkspace('scheduler-user', 'project-1', {
      repository: 'octocat/missing',
    })
    throw new Error('deveria ter lançado')
  } catch (err) {
    expect((err as Error & { killed?: boolean }).killed).toBeUndefined()
  }

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
