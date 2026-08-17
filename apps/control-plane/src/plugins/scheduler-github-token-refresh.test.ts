import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encryptCredential } from '../lib/credential-crypto.js'
import { resetEnvCache } from '../config/env.js'
import { renovarTokensGithubDoRelogio } from './scheduler.js'

/**
 * O ponto de LIGAÇÃO entre o relógio e a renovação automática do token do
 * GitHub. A decisão em si é pura e está testada caso a caso em
 * services/github-token-refresh.test.ts. Aqui só se prova o que só o
 * wiring pode errar: de onde vem a lista de conexões, com qual
 * client_id/secret a troca é feita, onde o novo par é gravado, e quando o
 * dono é avisado (e quando NÃO é, para não virar spam a cada tique).
 */

const AGORA = new Date('2026-08-17T12:00:00Z')

function fakeApp(args: {
  conexoes: Array<Record<string, unknown>>
  connectGitHubToken?: ReturnType<typeof vi.fn>
  updateMany?: ReturnType<typeof vi.fn>
  telegramLink?: Record<string, unknown> | null
  statusAtual?: string
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    prisma: {
      engineConnection: {
        findMany: vi.fn(async () => args.conexoes),
        findUnique: vi.fn(async () => ({ status: args.statusAtual ?? 'connected' })),
        updateMany: args.updateMany ?? vi.fn(async () => ({ count: 1 })),
      },
      user: { findUnique: vi.fn(async () => ({ email: 'dono@example.test' })) },
      telegramLink: { findUnique: vi.fn(async () => args.telegramLink ?? null) },
    },
    engineConnections: {
      connectGitHubToken: args.connectGitHubToken ?? vi.fn(async () => ({ status: 'connected' })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('renovarTokensGithubDoRelogio', () => {
  const originalFetch = global.fetch
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env['GITHUB_CLIENT_ID'] = 'Iv23test'
    process.env['GITHUB_CLIENT_SECRET'] = 'segredo-de-teste'
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-teste'
    resetEnvCache()
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  it('conexão perto de vencer é renovada: o novo par é gravado via connectGitHubToken', async () => {
    const refreshCifrado = encryptCredential('refresh_plano_abc')
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href === 'https://github.com/login/oauth/access_token') {
        return new Response(
          JSON.stringify({
            access_token: 'gh_novo_access',
            refresh_token: 'gh_novo_refresh',
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
          }),
          { status: 200 }
        )
      }
      throw new Error(`fetch inesperado: ${href}`)
    }) as unknown as typeof fetch

    const connectGitHubToken = vi.fn(async () => ({ status: 'connected' }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_1',
          encryptedRefreshToken: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 10 * 60 * 1000), // vence em 10 min < margem de 15
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      connectGitHubToken,
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.renovados).toBe(1)
    expect(connectGitHubToken).toHaveBeenCalledWith(
      'user_1',
      'gh_novo_access',
      expect.objectContaining({
        refreshToken: 'gh_novo_refresh',
        expiresAt: new Date(AGORA.getTime() + 28800 * 1000),
        refreshTokenExpiresAt: new Date(AGORA.getTime() + 15897600 * 1000),
      })
    )
  })

  it('GitHub recusa a renovação: status vira needs_reconnect e o dono é avisado UMA vez', async () => {
    const refreshCifrado = encryptCredential('refresh_plano_revogado')
    const telegramCalls: string[] = []
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 401 })
      }
      if (href.startsWith('https://api.telegram.org/bot')) {
        telegramCalls.push(String(init?.body))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`fetch inesperado: ${href}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_2',
          encryptedRefreshToken: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 5 * 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      updateMany,
      telegramLink: { status: 'linked', chatId: 'chat_123' },
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.precisamReconectar).toBe(1)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_2', runtime: 'github' },
        data: expect.objectContaining({ status: 'needs_reconnect' }),
      })
    )
    expect(telegramCalls).toHaveLength(1)
    expect(telegramCalls[0]).toContain('chat_123')
  })

  it('conexão legada sem refresh token guardado: avisa o dono, sem tentar renovar', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.startsWith('https://api.telegram.org/bot')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`fetch inesperado (não deveria chamar o GitHub): ${href}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_legado',
          encryptedRefreshToken: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
        },
      ],
      updateMany,
      telegramLink: { status: 'linked', chatId: 'chat_legado' },
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.precisamReconectar).toBe(1)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_legado', runtime: 'github' },
        data: expect.objectContaining({ status: 'needs_reconnect' }),
      })
    )
  })

  it('conexão já marcada needs_reconnect: NÃO reavisa o dono a cada tique', async () => {
    let chamouTelegram = false
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.startsWith('https://api.telegram.org/bot')) {
        chamouTelegram = true
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`fetch inesperado: ${href}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_ja_avisado',
          encryptedRefreshToken: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
        },
      ],
      updateMany,
      statusAtual: 'needs_reconnect',
      telegramLink: { status: 'linked', chatId: 'chat_x' },
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.precisamReconectar).toBe(1)
    expect(updateMany).toHaveBeenCalled()
    expect(chamouTelegram).toBe(false)
  })

  it('GITHUB_CLIENT_ID/SECRET ausentes: não toca o banco, devolve resumo zerado', async () => {
    delete process.env['GITHUB_CLIENT_ID']
    delete process.env['GITHUB_CLIENT_SECRET']
    resetEnvCache()

    const findMany = vi.fn(async () => [])
    const app = fakeApp({ conexoes: [] })
    app.prisma.engineConnection.findMany = findMany

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    // `falhasDeDecifragem` foi acrescentado à interface ResumoDaRenovacaoGithub
    // depois deste teste ter sido redigido (fix "distingue falha de
    // decifragem de recusa do GitHub") — o campo é obrigatório (sem `?`) e
    // precisa aparecer aqui zerado, senão o objeto retornado nunca bateria
    // com o tipo real de retorno da função.
    expect(resumo).toEqual({ renovados: 0, precisamReconectar: 0, falhasDeDecifragem: 0 })
    expect(findMany).not.toHaveBeenCalled()
  })
})
