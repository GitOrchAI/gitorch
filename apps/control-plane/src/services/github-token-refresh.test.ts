import { describe, expect, it, vi } from 'vitest'
import { CredentialDecryptError } from '../lib/credential-crypto.js'
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

  it('GitHub recusa com HTTP 200 (o formato real da resposta): lança RefreshTokenGithubInvalidoError mesmo assim', async () => {
    // O caso que de fato acontece em produção: o GitHub responde a troca
    // recusada com status 200 e o motivo dentro do CORPO (`error` /
    // `error_description`), nunca com um HTTP 4xx/5xx nesta rota. O teste
    // de 401 acima cobre uma resposta HTTP de erro "de livro" — mas é este
    // aqui, com status 200, que exercita o motivo real pelo qual a validação
    // (linhas acima) olha só para o conteúdo e nunca para `response.status`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'bad_refresh_token',
            error_description: 'The refresh token passed is incorrect or expired.',
          }),
          { status: 200 }
        )
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

  it('contrato: trocar recebe o valor cifrado exatamente como veio da conexão, sem nenhuma transformação', async () => {
    // O desenho inteiro deste arquivo depende disto: decifrar é
    // responsabilidade de quem MONTA `trocar` (Task 5), nunca desta
    // orquestração. Este teste falha se um refactor futuro passar a
    // decifrar, recortar, reformatar ou substituir o valor antes de
    // entregá-lo a `trocar` — o argumento recebido tem que ser o MESMO
    // valor, char por char, que `conexoes()` devolveu.
    const valorCifradoDaConexao = 'v1:iv-base64:authTag-base64:ciphertext-nao-e-pra-mexer=='
    const resultadoDeExemplo = {
      accessToken: 'gh_novo',
      refreshToken: 'gh_refresh_novo',
      expiresAt: new Date(AGORA.getTime() + 28800 * 1000),
      refreshTokenExpiresAt: new Date(AGORA.getTime() + 15897600 * 1000),
    }
    const trocar = vi.fn(async () => resultadoDeExemplo)

    await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_contrato',
          refreshTokenEncrypted: valorCifradoDaConexao,
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar,
      salvarSucesso: vi.fn(async () => undefined),
      marcarPrecisaReconectar: vi.fn(async () => undefined),
      agora: AGORA,
    })

    expect(trocar).toHaveBeenCalledTimes(1)
    expect(trocar).toHaveBeenCalledWith(valorCifradoDaConexao)
  })

  it('troca falha (GitHub recusou): marca precisa-reconectar com o motivo, não derruba as demais, e NÃO conta como falha de decifragem', async () => {
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
    expect(resumo.falhasDeDecifragem).toBe(0)
    expect(marcarPrecisaReconectar).toHaveBeenCalledWith('user_falha', 'bad_refresh_token')
  })

  it('troca falha (não conseguimos decifrar): conta como falha interna, NUNCA marca precisa-reconectar — não é culpa do cliente', async () => {
    // CredentialDecryptError (credential-crypto.ts) significa "a chave de
    // cifra do servidor mudou ou o dado corrompeu" — problema NOSSO. Pedir
    // para o cliente reconectar no GitHub não resolve nada (o refresh token
    // dele continua bom; só não conseguimos LER o que está cifrado no
    // banco). Por isso este caso tem que cair num contador separado de
    // RefreshTokenGithubInvalidoError ("o GitHub recusou o cartão", que sim
    // é problema do cliente) e jamais chamar marcarPrecisaReconectar.
    const marcarPrecisaReconectar = vi.fn(async () => undefined)

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_decifragem',
          refreshTokenEncrypted: 'envelope',
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: async () => {
        throw new CredentialDecryptError(
          'Falha ao decifrar credencial (chave trocada ou dado corrompido): unable to authenticate data'
        )
      },
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.falhasDeDecifragem).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(marcarPrecisaReconectar).not.toHaveBeenCalled()
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
    expect(resumo).toEqual({ renovados: 0, precisamReconectar: 0, falhasDeDecifragem: 0 })
  })
})
