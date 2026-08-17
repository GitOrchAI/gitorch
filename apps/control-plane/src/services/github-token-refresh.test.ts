import { describe, expect, it, vi, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CredentialDecryptError,
  decryptCredential,
  encryptCredential,
} from '../lib/credential-crypto.js'
import {
  MARGEM_DE_RENOVACAO_MS,
  RefreshTokenGithubInvalidoError,
  FalhaTransitoriaNaTrocaComGithubError,
  decidirAcaoGithub,
  trocarRefreshTokenNoGithub,
  renovarTokensGithubVencendo,
} from './github-token-refresh.js'

/** Base do resumo com os contadores adicionados na revisão da Task 5/F8
 *  (falhasTransitorias — Alto 3; legadosSemAcao — Crítico 1), para os
 *  testes que só querem afirmar sobre um contador específico não precisarem
 *  listar os outros toda vez. */
const RESUMO_ZERADO = {
  renovados: 0,
  precisamReconectar: 0,
  falhasDeDecifragem: 0,
  falhasTransitorias: 0,
  legadosSemAcao: 0,
}

const AGORA = new Date('2026-08-17T12:00:00Z')

describe('decidirAcaoGithub', () => {
  // Achado Crítico 1 (Task 5/F8): a coluna de refresh token é NOVA — no
  // primeiro tique depois do deploy desta fase, TODA conexão existente cai
  // no ramo "sem refreshTokenEncrypted" abaixo. Tratar isso como
  // "avisar-legado" (que renovarTokensGithubVencendo usa para marcar
  // 'needs_reconnect') SEM olhar o prazo cortaria o acesso de toda a base
  // no deploy — inclusive de quem tinha token perfeitamente válido. Os dois
  // testes abaixo (prazo no futuro/desconhecido vs. prazo vencido) são
  // exatamente o par que a revisão pediu para cobrir.
  it('sem refreshTokenEncrypted, mas o access_token atual ainda é válido: NÃO pede reconexão (legado informativo)', () => {
    const acao = decidirAcaoGithub(
      {
        refreshTokenEncrypted: null,
        expiresAt: new Date(AGORA.getTime() + 6 * 60 * 60 * 1000),
        refreshTokenExpiresAt: null,
      },
      AGORA
    )
    expect(acao.tipo).toBe('legado-token-valido')
  })

  it('sem refreshTokenEncrypted, e expiresAt desconhecido (null): também NÃO pede reconexão — nada indica falha', () => {
    const acao = decidirAcaoGithub(
      { refreshTokenEncrypted: null, expiresAt: null, refreshTokenExpiresAt: null },
      AGORA
    )
    expect(acao.tipo).toBe('legado-token-valido')
  })

  it('sem refreshTokenEncrypted, e o access_token JÁ venceu: aí sim pede reconexão', () => {
    const acao = decidirAcaoGithub(
      {
        refreshTokenEncrypted: null,
        expiresAt: new Date(AGORA.getTime() - 1000),
        refreshTokenExpiresAt: null,
      },
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

  // Achado Alto 3 (Task 5/F8): nem toda exceção aqui é "o GitHub recusou o
  // cartão do cliente" — a rede pode cair antes de qualquer resposta
  // chegar, ou a resposta pode não ser o JSON esperado (instabilidade do
  // GitHub, não recusa do refresh token). Os dois testes abaixo provam que
  // NENHUM dos dois casos lança RefreshTokenGithubInvalidoError — ambos têm
  // que virar FalhaTransitoriaNaTrocaComGithubError, para
  // renovarTokensGithubVencendo nunca culpar o cliente por isso.
  it('rede cai (fetchImpl rejeita): lança FalhaTransitoriaNaTrocaComGithubError, NUNCA RefreshTokenGithubInvalidoError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    let capturado: unknown
    try {
      await trocarRefreshTokenNoGithub({
        refreshToken: 'gh_refresh_qualquer',
        clientId: 'Iv23test',
        clientSecret: 'segredo',
        fetchImpl,
      })
    } catch (err) {
      capturado = err
    }

    // toBeInstanceOf (não toThrow(Classe)): checagem de TIPO de verdade — se
    // FalhaTransitoriaNaTrocaComGithubError não existisse, `toThrow(undefined)`
    // aceitaria QUALQUER erro lançado (o comportamento antigo, sem distinção
    // nenhuma, passaria escondido por baixo do teste).
    expect(capturado).toBeInstanceOf(FalhaTransitoriaNaTrocaComGithubError)
    expect(capturado).not.toBeInstanceOf(RefreshTokenGithubInvalidoError)
  })

  it('resposta não é JSON (página de erro HTML numa instabilidade): lança FalhaTransitoriaNaTrocaComGithubError, NUNCA RefreshTokenGithubInvalidoError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })
    ) as unknown as typeof fetch

    let capturado: unknown
    try {
      await trocarRefreshTokenNoGithub({
        refreshToken: 'gh_refresh_qualquer',
        clientId: 'Iv23test',
        clientSecret: 'segredo',
        fetchImpl,
      })
    } catch (err) {
      capturado = err
    }

    expect(capturado).toBeInstanceOf(FalhaTransitoriaNaTrocaComGithubError)
    expect(capturado).not.toBeInstanceOf(RefreshTokenGithubInvalidoError)
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

  // Achado Crítico 1 (Task 5/F8) na ORQUESTRAÇÃO (não só na decisão pura
  // acima): o deploy desta fase não pode mudar o status de NENHUMA conexão
  // que ainda tenha um access_token válido, mesmo sem refresh token
  // guardado — senão corta o acesso ao GitHub de toda a base existente.
  it('conexão legada (sem refresh token) com access_token AINDA válido: NÃO marca precisa-reconectar, nunca chama trocar, conta em legadosSemAcao', async () => {
    const trocar = vi.fn()
    const marcarPrecisaReconectar = vi.fn(async () => undefined)

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_legado_valido',
          refreshTokenEncrypted: null,
          expiresAt: new Date(AGORA.getTime() + 6 * 60 * 60 * 1000),
          refreshTokenExpiresAt: null,
        },
      ],
      trocar,
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.legadosSemAcao).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(trocar).not.toHaveBeenCalled()
    expect(marcarPrecisaReconectar).not.toHaveBeenCalled()
  })

  it('conexão legada (sem refresh token) com access_token JÁ vencido: marca precisa-reconectar, nunca chama trocar', async () => {
    const trocar = vi.fn()
    const marcarPrecisaReconectar = vi.fn(async () => undefined)

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_legado_vencido',
          refreshTokenEncrypted: null,
          expiresAt: new Date(AGORA.getTime() - 1000),
          refreshTokenExpiresAt: null,
        },
      ],
      trocar,
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.precisamReconectar).toBe(1)
    expect(resumo.legadosSemAcao).toBe(0)
    expect(trocar).not.toHaveBeenCalled()
    expect(marcarPrecisaReconectar).toHaveBeenCalledTimes(1)
  })

  // Achado Alto 3, na orquestração: uma instabilidade transitória (rede
  // caiu, resposta não era JSON) nunca pode marcar a conexão como
  // "precisa reconectar" — só o GitHub RECUSANDO o cartão (
  // RefreshTokenGithubInvalidoError) faz isso.
  it('troca falha (instabilidade transitória): conta em falhasTransitorias, NUNCA marca precisa-reconectar', async () => {
    const marcarPrecisaReconectar = vi.fn(async () => undefined)

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_instavel',
          refreshTokenEncrypted: 'envelope',
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: async () => {
        throw new FalhaTransitoriaNaTrocaComGithubError('não foi possível alcançar o GitHub')
      },
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.falhasTransitorias).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(marcarPrecisaReconectar).not.toHaveBeenCalled()
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
    expect(resumo).toEqual(RESUMO_ZERADO)
  })

  // Achado Médio 5: sem teto, uma leva de expirações concentradas
  // serializaria N chamadas de rede num único tique. `tetoPorTique` existe
  // só para o teste exercitar isto sem montar centenas de conexões falsas
  // — em produção vale o default (TETO_DE_RENOVACOES_POR_TIQUE).
  it('teto por tique: processa só as N primeiras, o resto fica para o próximo tique', async () => {
    const trocar = vi.fn(async () => ({
      accessToken: 'gh_novo',
      refreshToken: 'gh_refresh_novo',
      expiresAt: new Date(AGORA.getTime() + 28800 * 1000),
      refreshTokenExpiresAt: new Date(AGORA.getTime() + 15897600 * 1000),
    }))
    const conexoes = Array.from({ length: 5 }, (_, i) => ({
      userId: `user_${i}`,
      refreshTokenEncrypted: 'envelope',
      expiresAt: new Date(AGORA.getTime() + 60 * 1000),
      refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
    }))

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => conexoes,
      trocar,
      salvarSucesso: vi.fn(async () => undefined),
      marcarPrecisaReconectar: vi.fn(async () => undefined),
      agora: AGORA,
      tetoPorTique: 2,
    })

    expect(trocar).toHaveBeenCalledTimes(2)
    expect(resumo.renovados).toBe(2)
  })
})

// Achado Alto 4 (Task 5/F8): "Nenhum teste exercita uma falha de decifragem
// REAL através da composição de verdade (decryptCredential real +
// trocarRefreshTokenNoGithub)". Toda a cobertura acima usa um `trocar`
// MOCADO lançando CredentialDecryptError direto — prova o agrupamento, mas
// não prova que a composição de verdade (o que scheduler.ts de fato monta:
// `trocar = async (enc) => trocarRefreshTokenNoGithub({ refreshToken:
// decryptCredential(enc), ... })`) PRODUZ esse erro. Os dois achados
// CRÍTICOS (1 e 2) passariam por todos os testes acima sem serem notados
// exatamente por essa lacuna. Este bloco compõe as funções REAIS — sem
// mockar trocar, sem mockar decryptCredential — igual ao que
// renovarTokensGithubDoRelogio (scheduler.ts) monta.
describe('renovarTokensGithubVencendo com a composição REAL (achado Alto 4)', () => {
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']
  afterEach(() => {
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  /** A MESMA composição que scheduler.ts monta em renovarTokensGithubDoRelogio
   *  — decifra de verdade, depois troca com o GitHub de verdade (fetchImpl
   *  injetado só para não bater na rede real). */
  function trocarComposicaoReal(fetchImpl: typeof fetch) {
    return async (refreshTokenEncrypted: string) => {
      const refreshTokenPlano = decryptCredential(refreshTokenEncrypted)
      return trocarRefreshTokenNoGithub({
        refreshToken: refreshTokenPlano,
        clientId: 'Iv23test',
        clientSecret: 'segredo',
        fetchImpl,
        agora: AGORA,
      })
    }
  }

  it('GITORCH_CREDENTIAL_KEY ausente no momento da renovação: a falha atravessa como CredentialDecryptError e conta em falhasDeDecifragem, NUNCA marca precisa-reconectar', async () => {
    // A chave existia quando a conexão foi cifrada — mas SUMIU antes deste
    // tique rodar (achado Crítico 2: loadKey() lançava Error genérico aqui,
    // ANTES do try/catch de decryptCredential, e o erro chegava a este
    // catch como se o GitHub tivesse recusado o cartão).
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    const refreshCifrado = encryptCredential('refresh_plano_abc')
    delete process.env['GITORCH_CREDENTIAL_KEY']

    const marcarPrecisaReconectar = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(async () => {
      throw new Error('não deveria chamar o GitHub — a decifragem falha antes')
    }) as unknown as typeof fetch

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_chave_ausente',
          refreshTokenEncrypted: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: trocarComposicaoReal(fetchImpl),
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.falhasDeDecifragem).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(marcarPrecisaReconectar).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('GITORCH_CREDENTIAL_KEY com tamanho errado no momento da renovação: mesma classificação — falhasDeDecifragem, NUNCA precisa-reconectar', async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    const refreshCifrado = encryptCredential('refresh_plano_abc')
    process.env['GITORCH_CREDENTIAL_KEY'] = 'deadbeef' // formato inválido

    const marcarPrecisaReconectar = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(async () => {
      throw new Error('não deveria chamar o GitHub — a decifragem falha antes')
    }) as unknown as typeof fetch

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_chave_malformada',
          refreshTokenEncrypted: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: trocarComposicaoReal(fetchImpl),
      salvarSucesso: vi.fn(),
      marcarPrecisaReconectar,
      agora: AGORA,
    })

    expect(resumo.falhasDeDecifragem).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(marcarPrecisaReconectar).not.toHaveBeenCalled()
  })

  it('chave presente e a troca com o GitHub sucede de verdade: composição real completa funciona ponta a ponta (controle positivo)', async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    const refreshCifrado = encryptCredential('refresh_plano_bom')

    const salvarSucesso = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'gh_novo',
          refresh_token: 'gh_refresh_novo',
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const resumo = await renovarTokensGithubVencendo({
      conexoes: async () => [
        {
          userId: 'user_composicao_ok',
          refreshTokenEncrypted: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      trocar: trocarComposicaoReal(fetchImpl),
      salvarSucesso,
      marcarPrecisaReconectar: vi.fn(),
      agora: AGORA,
    })

    expect(resumo.renovados).toBe(1)
    expect(resumo.falhasDeDecifragem).toBe(0)
    expect(salvarSucesso).toHaveBeenCalledWith(
      'user_composicao_ok',
      expect.objectContaining({ accessToken: 'gh_novo', refreshToken: 'gh_refresh_novo' })
    )
  })
})
