import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  guardarCredencialDoProjeto,
  lerCredencialDoProjeto,
  lerCredencialQueAlcancaOProjeto,
  verificarCredencial,
  VerificacaoIndisponivelError,
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

  // 401 é a única resposta que a API do GitHub reserva para credencial
  // inválida/expirada neste endpoint (mesma garantia usada em
  // classifyGithubApiError). Qualquer outro status de falha é o GitHub
  // instável, não a credencial — devolver nulo aqui diria ao cliente "sua
  // credencial está errada" quando o problema não é dele.
  it('GitHub indisponível (5xx) não vira "credencial inválida" — lança para o chamador distinguir', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }))
    await expect(
      verificarCredencial({ token: 't', fetchImpl: fetchImpl as never })
    ).rejects.toBeInstanceOf(VerificacaoIndisponivelError)
  })

  // Mesmo raciocínio do teste de 5xx acima, mas para o caso em que o GitHub
  // nem chega a responder: sem tempo-limite, esta é a única chamada externa
  // de uma rota síncrona e o cliente ficaria preso na tela do wizard
  // indefinidamente. `fetchQueNuncaResponde` imita o `fetch` nativo: honra o
  // `signal` recebido e rejeita com o mesmo TimeoutError que
  // `AbortSignal.timeout` produz de verdade (confirmado contra o fetch
  // nativo do Node).
  it('GitHub não responde a tempo — estouro é indisponibilidade, não credencial inválida', async () => {
    const fetchImpl = fetchQueNuncaResponde()
    await expect(
      verificarCredencial({ token: 't', fetchImpl: fetchImpl as never, timeoutMs: 5 })
    ).rejects.toBeInstanceOf(VerificacaoIndisponivelError)
  })
})

/** Fake de `fetch` que nunca resolve por conta própria — só reage ao aborto
 *  do `signal`, exatamente como o `fetch` nativo faz quando
 *  `AbortSignal.timeout` dispara. Usado para testar tempo-limite sem
 *  depender de rede real nem de temporizadores globais mockados. */
function fetchQueNuncaResponde(): typeof fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal!.reason as Error)
      })
    })
  }) as unknown as typeof fetch
}

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
    const update = vi.fn(
      async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})
    )
    await guardarCredencialDoProjeto({
      prisma: { project: { update, findUnique: vi.fn() } } as never,
      projectId: 'proj_1',
      token: 'segredo-do-cliente',
    })
    const gravado = update.mock.calls[0]![0].data['encryptedClientToken'] as string
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

// D15 (01/09/2026, task ce67b8bd): o dono já deu a credencial do GitHub uma
// vez, no login (engine_connections, runtime='github', status='connected') —
// pedir para colar de novo em /api/v1/setup/credencial-do-cliente sempre que
// um projeto NOVO ainda não tem PAT próprio guardado é atrito desnecessário.
// Este helper é o ponto ÚNICO onde a ordem de preferência mora: primeiro o
// que o cliente colou explicitamente PARA ESTE projeto (mais alcance —
// D13/PR#445 provou que só um PAT clássico com escopo `project` cria/lê
// Projects V2 de conta pessoal), só depois o que ele já deu no login.
describe('lerCredencialQueAlcancaOProjeto', () => {
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']
  beforeEach(() => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  it('com PAT do próprio projeto guardado, usa ele — nunca chega a consultar engine_connections', async () => {
    // Espia lerCredencialDoProjeto via um prisma que já devolve o valor
    // decifrável esperado (mesmo padrão do teste "o que foi guardado volta
    // igual ao original" acima).
    let cofre = ''
    const prismaComPat = {
      project: {
        update: vi.fn(async (args: never) => {
          cofre = (args as { data: { encryptedClientToken: string } }).data.encryptedClientToken
          return {}
        }),
        findUnique: vi.fn(async () => ({ encryptedClientToken: cofre })),
      },
    }
    await guardarCredencialDoProjeto({
      prisma: prismaComPat as never,
      projectId: 'proj_1',
      token: 'pat-do-cliente',
    })
    const getRawGithubToken = vi.fn(async () => 'token-do-login')

    const resultado = await lerCredencialQueAlcancaOProjeto({
      prisma: prismaComPat as never,
      projectId: 'proj_1',
      userId: 'user_1',
      engineConnections: { getRawGithubToken },
    })

    expect(resultado).toBe('pat-do-cliente')
    expect(getRawGithubToken).not.toHaveBeenCalled()
  })

  it('sem PAT do projeto, cai na credencial que o dono já deu no login (engine_connections) — nunca pede de novo', async () => {
    const prisma = {
      project: {
        update: vi.fn(),
        findUnique: vi.fn(async () => ({ encryptedClientToken: null })),
      },
    }
    const getRawGithubToken = vi.fn(async () => 'token-do-login')

    const resultado = await lerCredencialQueAlcancaOProjeto({
      prisma: prisma as never,
      projectId: 'proj_1',
      userId: 'user_1',
      engineConnections: { getRawGithubToken },
    })

    expect(resultado).toBe('token-do-login')
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
  })

  it('sem nenhuma das duas, devolve nulo — quem chama decide se aí sim pede ao dono', async () => {
    const prisma = {
      project: {
        update: vi.fn(),
        findUnique: vi.fn(async () => ({ encryptedClientToken: null })),
      },
    }
    const getRawGithubToken = vi.fn(async () => null)

    await expect(
      lerCredencialQueAlcancaOProjeto({
        prisma: prisma as never,
        projectId: 'proj_1',
        userId: 'user_1',
        engineConnections: { getRawGithubToken },
      })
    ).resolves.toBeNull()
  })

  it('sem userId (projeto legado) ou sem engineConnections injetado, nunca lança — só perde o reforço', async () => {
    const prisma = {
      project: {
        update: vi.fn(),
        findUnique: vi.fn(async () => ({ encryptedClientToken: null })),
      },
    }

    await expect(
      lerCredencialQueAlcancaOProjeto({
        prisma: prisma as never,
        projectId: 'proj_1',
        userId: null,
      })
    ).resolves.toBeNull()
  })

  it('erro ao ler o token de login (banco fora do ar, chave rotacionada) nunca sobe — resolve em nulo', async () => {
    const prisma = {
      project: {
        update: vi.fn(),
        findUnique: vi.fn(async () => ({ encryptedClientToken: null })),
      },
    }
    const getRawGithubToken = vi.fn(async () => {
      throw new Error('banco fora do ar')
    })

    await expect(
      lerCredencialQueAlcancaOProjeto({
        prisma: prisma as never,
        projectId: 'proj_1',
        userId: 'user_1',
        engineConnections: { getRawGithubToken },
      })
    ).resolves.toBeNull()
  })
})
