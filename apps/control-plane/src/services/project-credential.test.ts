import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  guardarCredencialDoProjeto,
  lerCredencialDoProjeto,
  verificarCredencial,
} from './project-credential.js'

const resposta = (escopos: string, login = 'alguem') =>
  new Response(JSON.stringify({ login }), {
    status: 200,
    headers: { 'x-oauth-scopes': escopos },
  })

describe('verificarCredencial', () => {
  it('lê os escopos que a plataforma declara no cabeçalho', async () => {
    const fetchImpl = vi.fn(async () => resposta('repo, project, workflow'))
    const r = await verificarCredencial({ token: 't', fetchImpl: fetchImpl as never })
    expect(r).toEqual({ login: 'alguem', escopos: ['repo', 'project', 'workflow'], faltando: [] })
  })

  it('aponta exatamente o que falta, para o aviso poder ser acionável', async () => {
    const fetchImpl = vi.fn(async () => resposta('repo'))
    const r = await verificarCredencial({ token: 't', fetchImpl: fetchImpl as never })
    expect(r?.faltando).toEqual(['project'])
  })

  it('token que não autentica resolve em nulo, não em exceção', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(
      verificarCredencial({ token: 't', fetchImpl: fetchImpl as never })
    ).resolves.toBeNull()
  })

  // Credencial de formato novo não devolve o cabeçalho de escopos. Tratar
  // ausência como "sem escopo nenhum" mandaria o cliente atrás de algo que ele
  // não tem como mostrar; o certo é dizer que não dá para verificar.
  it('sem o cabeçalho de escopos, não inventa que está tudo certo', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ login: 'alguem' }), { status: 200 })
    )
    const r = await verificarCredencial({ token: 't', fetchImpl: fetchImpl as never })
    expect(r).toEqual({ login: 'alguem', escopos: [], faltando: ['repo', 'project'] })
  })
})

describe('guardarCredencialDoProjeto / lerCredencialDoProjeto', () => {
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']

  beforeEach(() => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  it('a credencial nunca é gravada em texto puro', async () => {
    const update = vi.fn(async () => ({}))
    await guardarCredencialDoProjeto({
      prisma: { project: { update, findUnique: vi.fn() } } as never,
      projectId: 'proj_1',
      token: 'segredo-do-cliente',
    })
    const gravado = update.mock.calls[0]![0].data.encryptedClientToken as string
    expect(gravado).not.toContain('segredo-do-cliente')
    expect(gravado.length).toBeGreaterThan(0)
  })

  it('o que foi guardado volta igual ao original', async () => {
    let cofre = ''
    const prisma = {
      project: {
        update: vi.fn(async (args: never) => {
          cofre = (args as { data: { encryptedClientToken: string } }).data.encryptedClientToken
          return {}
        }),
        findUnique: vi.fn(async () => ({ encryptedClientToken: cofre })),
      },
    } as never

    await guardarCredencialDoProjeto({ prisma, projectId: 'proj_1', token: 'segredo-do-cliente' })
    await expect(lerCredencialDoProjeto({ prisma, projectId: 'proj_1' })).resolves.toBe(
      'segredo-do-cliente'
    )
  })

  it('projeto sem credencial devolve nulo, não erro', async () => {
    const prisma = {
      project: { update: vi.fn(), findUnique: vi.fn(async () => ({ encryptedClientToken: null })) },
    } as never
    await expect(lerCredencialDoProjeto({ prisma, projectId: 'proj_1' })).resolves.toBeNull()
  })
})
