import { describe, it, expect, vi } from 'vitest'
import { verificarCredencial } from './project-credential.js'

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
