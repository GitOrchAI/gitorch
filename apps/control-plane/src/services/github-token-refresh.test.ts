import { describe, expect, it, vi } from 'vitest'
import {
  MARGEM_DE_RENOVACAO_MS,
  RefreshTokenGithubInvalidoError,
  decidirAcaoGithub,
  trocarRefreshTokenNoGithub,
  renovarTokensGithubVencendo,
} from './github-token-refresh.js'

const AGORA = new Date('2026-08-17T12:00:00Z')

describe('decidirAcaoGithub', () => {
  it('sem refreshTokenEncrypted: avisa que é conexão legada, não tenta renovar', () => {
    const acao = decidirAcaoGithub(
      { refreshTokenEncrypted: null, expiresAt: null, refreshTokenExpiresAt: null },
      AGORA
    )
    expect(acao.tipo).toBe('avisar-legado')
  })

  it('refresh token do GitHub venceu: avisa, não tenta renovar', () => {
    const acao = decidirAcaoGithub(
      {
        refreshTokenEncrypted: 'envelope',
        expiresAt: new Date(AGORA.getTime() + 60 * 60 * 1000),
        refreshTokenExpiresAt: new Date(AGORA.getTime() - 1000),
      },
      AGORA
    )
    expect(acao.tipo).toBe('avisar-legado')
  })

  it('dentro da margem de renovação: renova', () => {
    const acao = decidirAcaoGithub(
      {
        refreshTokenEncrypted: 'envelope',
        expiresAt: new Date(AGORA.getTime() + MARGEM_DE_RENOVACAO_MS - 1000),
        refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
      },
      AGORA
    )
    expect(acao.tipo).toBe('renovar')
  })

  it('longe do vencimento: nada a fazer', () => {
    const acao = decidirAcaoGithub(
      {
        refreshTokenEncrypted: 'envelope',
        expiresAt: new Date(AGORA.getTime() + 6 * 60 * 60 * 1000),
        refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
      },
      AGORA
    )
    expect(acao.tipo).toBe('nada')
  })
})

describe('trocarRefreshTokenNoGithub', () => {
  it('troca bem-sucedida: devolve o novo par com as datas calculadas', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'gh_novo',
            refresh_token: 'gh_refresh_novo',
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch

    const resultado = await trocarRefreshTokenNoGithub({
      refreshToken: 'gh_refresh_velho',
      clientId: 'Iv23test',
      clientSecret: 'segredo',
      fetchImpl,
      agora: AGORA,
    })

    expect(resultado.accessToken).toBe('gh_novo')
    expect(resultado.refreshToken).toBe('gh_refresh_novo')
    expect(resultado.expiresAt).toEqual(new Date(AGORA.getTime() + 28800 * 1000))
    expect(resultado.refreshTokenExpiresAt).toEqual(new Date(AGORA.getTime() + 15897600 * 1000))

    // Cast do mesmo jeito que o resto da suíte já faz (ex.:
    // security-debt-collector.test.ts): `fetchImpl` é tipado como `typeof fetch`
    // (para bater com a assinatura que trocarRefreshTokenNoGithub espera), e
    // `typeof fetch` não expõe `.mock` — só o vi.fn() por trás dele expõe.
    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      RequestInit,
    ]
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      client_id: 'Iv23test',
      client_secret: 'segredo',
      grant_type: 'refresh_token',
      refresh_token: 'gh_refresh_velho',
    })
  })

  it('GitHub recusa: lança RefreshTokenGithubInvalidoError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 401 })
    ) as unknown as typeof fetch

    await expect(
      trocarRefreshTokenNoGithub({
        refreshToken: 'gh_refresh_revogado',
        clientId: 'Iv23test',
        clientSecret: 'segredo',
        fetchImpl,
      })
    ).rejects.toThrow(RefreshTokenGithubInvalidoError)
  })
})

describe('renovarTokensGithubVencendo', () => {
  it('renova a conexão elegível e chama salvarSucesso com o resultado', async () => {
    const salvarSucesso = vi.fn(async () => undefined)
    const marcarPrecisaReconectar = vi.fn(async () => undefined)
    const resultado = {
      accessToken: 'gh_novo',
      refreshToken: 'gh_refresh_novo',
      expiresAt: new Date(AGORA.getTime() + 28800 * 1000),
      refreshTokenExpiresAt: new Date(AGORA.getTime() + 15897600 * 1000),
    }

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_1',
          refreshTokenEncrypted: 'envelope',
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: async () => resultado,
      salvarSucesso,
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.renovados).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(salvarSucesso).toHaveBeenCalledWith('user_1', resultado)
    expect(marcarPrecisaReconectar).not.toHaveBeenCalled()
  })

  it('troca falha: marca precisa-reconectar com o motivo, não derruba as demais', async () => {
    const marcarPrecisaReconectar = vi.fn(async () => undefined)

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_falha',
          refreshTokenEncrypted: 'envelope',
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: async () => {
        throw new RefreshTokenGithubInvalidoError('bad_refresh_token')
      },
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.precisamReconectar).toBe(1)
    expect(marcarPrecisaReconectar).toHaveBeenCalledWith('user_falha', 'bad_refresh_token')
  })

  it('conexão legada (sem refresh token): marca precisa-reconectar, nunca chama trocar', async () => {
    const trocar = vi.fn()
    const marcarPrecisaReconectar = vi.fn(async () => undefined)

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_legado',
          refreshTokenEncrypted: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
        },
      ],
      trocar,
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.precisamReconectar).toBe(1)
    expect(trocar).not.toHaveBeenCalled()
    expect(marcarPrecisaReconectar).toHaveBeenCalledTimes(1)
  })

  it('listar conexões falha: não lança, devolve resumo zerado', async () => {
    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => {
        throw new Error('banco fora do ar')
      },
      trocar: vi.fn(),
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar: vi.fn(),
      agora: AGORA,
    })
    expect(resumo).toEqual({ renovados: 0, precisamReconectar: 0 })
  })
})
