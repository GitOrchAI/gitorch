import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mintInstallationToken, resetAppTokenCache } from './github-app-token.js'

function makeKeypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

type Call = { url: string; init: RequestInit | undefined }

/** fetch fake: 1ª chamada resolve a instalação, 2ª emite o token. */
function fakeGithub(opts: {
  installationId?: number
  token?: string
  expiresInMs?: number
  calls?: Call[]
}) {
  const { installationId = 4242, token = 'ghs_test123', expiresInMs = 3_600_000, calls } = opts
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls?.push({ url: String(url), init })
    if (String(url).endsWith('/app/installations')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: installationId }],
      } as unknown as Response
    }
    if (String(url).includes('/access_tokens')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
      } as unknown as Response
    }
    throw new Error('URL inesperada no teste: ' + url)
  }) as unknown as typeof fetch
}

describe('mintInstallationToken', () => {
  beforeEach(() => resetAppTokenCache())

  it('retorna null (e não chama a rede) quando faltam credenciais do App', async () => {
    const fetchImpl = (async () => {
      throw new Error('não deveria tocar a rede sem credenciais')
    }) as unknown as typeof fetch
    expect(
      await mintInstallationToken({ appId: undefined, privateKey: undefined, fetchImpl })
    ).toBeNull()
    expect(await mintInstallationToken({ appId: '1', privateKey: undefined, fetchImpl })).toBeNull()
  })

  it('assina um JWT RS256 válido pela chave do App e o troca por installation token', async () => {
    const { publicKey, privateKey } = makeKeypair()
    const calls: Call[] = []
    const token = await mintInstallationToken({
      appId: '999',
      privateKey,
      fetchImpl: fakeGithub({ calls }),
      now: () => 1_700_000_000_000,
    })
    expect(token).toBe('ghs_test123')

    // 1º request usa Bearer <JWT> assinado pela NOSSA chave privada
    const auth = String((calls[0]!.init!.headers as Record<string, string>)['Authorization'])
    expect(auth.startsWith('Bearer ')).toBe(true)
    const [h, p, s] = auth.slice('Bearer '.length).split('.') as [string, string, string]
    const signatureOk = verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s, 'base64url')
    )
    expect(signatureOk).toBe(true)

    // claims corretos: iss = appId, exp no futuro
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
      iss: string
      iat: number
      exp: number
    }
    expect(payload.iss).toBe('999')
    expect(payload.exp).toBeGreaterThan(payload.iat)

    // 2º request é POST no endpoint da instalação resolvida
    expect(calls[1]!.url).toContain('/app/installations/4242/access_tokens')
    expect(calls[1]!.init?.method).toBe('POST')
  })

  it('faz cache: segunda chamada não refaz nenhuma requisição', async () => {
    const { privateKey } = makeKeypair()
    const calls: Call[] = []
    const fetchImpl = fakeGithub({ token: 'ghs_cached', calls })
    const first = await mintInstallationToken({ appId: '1', privateKey, fetchImpl })
    const afterFirst = calls.length
    const second = await mintInstallationToken({ appId: '1', privateKey, fetchImpl })
    expect(first).toBe('ghs_cached')
    expect(second).toBe('ghs_cached')
    expect(calls.length).toBe(afterFirst) // zero requisições novas
  })

  it('re-emite quando o token em cache está perto de expirar', async () => {
    const { privateKey } = makeKeypair()
    const calls: Call[] = []
    // token que "expira" em 30s; com skew de 60s ja e considerado vencido
    const fetchImpl = fakeGithub({ token: 'ghs_short', expiresInMs: 30_000, calls })
    await mintInstallationToken({ appId: '1', privateKey, fetchImpl })
    const afterFirst = calls.length
    await mintInstallationToken({ appId: '1', privateKey, fetchImpl })
    expect(calls.length).toBeGreaterThan(afterFirst) // re-emitiu
  })

  it('retorna null sem lançar quando a API do GitHub falha', async () => {
    const { privateKey } = makeKeypair()
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch
    expect(await mintInstallationToken({ appId: '1', privateKey, fetchImpl })).toBeNull()
  })

  it('chave privada inválida: devolve null E registra o motivo real (não some com o erro)', async () => {
    const logged: unknown[] = []
    const token = await mintInstallationToken({
      appId: '4038070',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nchave-truncada\n-----END RSA PRIVATE KEY-----',
      fetchImpl: (async () => {
        throw new Error('a rede nunca deve ser tocada: a assinatura falha antes')
      }) as unknown as typeof fetch,
      onError: (message: string) => logged.push(message),
    })

    expect(token).toBeNull()
    expect(logged).toHaveLength(1)
    expect(String(logged[0])).toContain('GITHUB_APP_PRIVATE_KEY')
  })

  it('App não configurado: devolve null em silêncio, sem reportar erro', async () => {
    const logged: unknown[] = []
    const token = await mintInstallationToken({
      appId: undefined,
      privateKey: undefined,
      onError: (message: string) => logged.push(message),
    })

    expect(token).toBeNull()
    expect(logged).toEqual([])
  })
})

/**
 * F1 Onda 2 — installationId explícito: um cliente do wizard escolheu SUA
 * instalação (users.github_installation_id), diferente da instalação[0] que
 * o caminho dos trilhos usa por padrão. As duas nunca podem se confundir —
 * nem no token devolvido, nem no cache.
 */
describe('mintInstallationToken — installationId explícito (por usuário)', () => {
  beforeEach(() => resetAppTokenCache())

  it('com installationId explícito, pula a listagem e mint direto naquela instalação', async () => {
    const { privateKey } = makeKeypair()
    const calls: Call[] = []
    const fetchImpl = fakeGithub({ token: 'ghs_user_7', calls })

    const token = await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl,
      installationId: 7,
    })

    expect(token).toBe('ghs_user_7')
    expect(calls).toHaveLength(1) // nenhuma chamada a /app/installations
    expect(calls[0]!.url).toContain('/app/installations/7/access_tokens')
  })

  it('instalações diferentes nunca compartilham token nem cache', async () => {
    const { privateKey } = makeKeypair()
    const callsA: Call[] = []
    const tokenA = await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl: fakeGithub({ token: 'ghs_A', calls: callsA }),
      installationId: 111,
    })

    const callsB: Call[] = []
    const tokenB = await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl: fakeGithub({ token: 'ghs_B', calls: callsB }),
      installationId: 222,
    })

    expect(tokenA).toBe('ghs_A')
    expect(tokenB).toBe('ghs_B')
    expect(callsB[0]!.url).toContain('/app/installations/222/access_tokens')

    // Repetir a 111 usa o CACHE dela (nunca o token/estado da 222)
    const callsA2: Call[] = []
    const tokenA2 = await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl: fakeGithub({ token: 'nao-deveria-usar-este', calls: callsA2 }),
      installationId: 111,
    })
    expect(tokenA2).toBe('ghs_A')
    expect(callsA2).toHaveLength(0) // cache hit, zero rede
  })

  it('installationId explícito não contamina o cache do caminho default (installations[0])', async () => {
    const { privateKey } = makeKeypair()
    // caminho default (sem installationId): resolve installations[0] = 4242
    const callsDefault: Call[] = []
    const tokenDefault = await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl: fakeGithub({ installationId: 4242, token: 'ghs_default', calls: callsDefault }),
    })
    expect(tokenDefault).toBe('ghs_default')

    // usuário com instalação explícita diferente
    const callsUser: Call[] = []
    await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl: fakeGithub({ token: 'ghs_user', calls: callsUser }),
      installationId: 999,
    })

    // caminho default de novo: ainda serve o token de 4242 do cache, sem
    // rede nova (a instalação explícita de outro dono não interferiu)
    const callsDefault2: Call[] = []
    const tokenDefault2 = await mintInstallationToken({
      appId: '1',
      privateKey,
      fetchImpl: fakeGithub({
        installationId: 4242,
        token: 'nao-deveria-usar-este',
        calls: callsDefault2,
      }),
    })
    expect(tokenDefault2).toBe('ghs_default')
    expect(callsDefault2).toHaveLength(0)
  })
})
