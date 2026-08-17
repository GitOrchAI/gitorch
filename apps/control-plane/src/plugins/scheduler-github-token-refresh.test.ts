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

/** Busca recursiva por uma substring em QUALQUER propriedade (própria,
 *  inclusive não-enumerável — message/stack de Error não são enumeráveis) de
 *  um valor arbitrário, incluindo `.cause` encadeado. Usada pelo teste do
 *  achado ⚠️ CRÍTICO: prova que o que chega em `app.log.warn` está limpo,
 *  não só que `JSON.stringify` não mostra nada (Error.message/.stack
 *  escapariam de um `JSON.stringify` ingênuo por não serem enumeráveis). */
function algumaPropriedadeContemTexto(
  valor: unknown,
  agulha: string,
  vistos = new Set<unknown>()
): boolean {
  if (valor === null || valor === undefined) return false
  if (typeof valor === 'string') return valor.includes(agulha)
  if (typeof valor !== 'object' && typeof valor !== 'function') return false
  if (vistos.has(valor)) return false
  vistos.add(valor)
  for (const chave of Object.getOwnPropertyNames(valor)) {
    if (chave === 'stack' || chave === 'message' || chave === 'cause') {
      const sub = (valor as Record<string, unknown>)[chave]
      if (algumaPropriedadeContemTexto(sub, agulha, vistos)) return true
      continue
    }
    let sub: unknown
    try {
      sub = (valor as Record<string, unknown>)[chave]
    } catch {
      continue
    }
    if (algumaPropriedadeContemTexto(sub, agulha, vistos)) return true
  }
  return false
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

  // Achado Baixo 6 (Task 5/F8): o `.catch(...)` que existia em volta de
  // `notify(...)` era código morto — buildTelegramNotifier já engolia a
  // falha de entrega internamente, então o dono nunca sabia que o aviso de
  // reconexão não chegou. Prova, no wiring real, que uma falha de entrega
  // (aqui: o Telegram responde erro) agora deixa rastro em app.log.warn.
  it('GitHub recusa a renovação, e a entrega do aviso por Telegram FALHA: a falha de entrega fica registrada em log, não some', async () => {
    const refreshCifrado = encryptCredential('refresh_plano_revogado')
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 401 })
      }
      if (href.startsWith('https://api.telegram.org/bot')) {
        // A REJEIÇÃO (não um status HTTP de erro — buildTelegramNotifier não
        // olha response.ok) é a falha de entrega real que ela engolia por
        // dentro: rede caída, DNS falhou, etc.
        throw new Error('ECONNREFUSED: rede indisponível para o Telegram')
      }
      throw new Error(`fetch inesperado: ${href}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_telegram_falha',
          encryptedRefreshToken: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 5 * 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      updateMany,
      telegramLink: { status: 'linked', chatId: 'chat_falha' },
    })

    await renovarTokensGithubDoRelogio(app, AGORA)

    expect(app.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('aviso de reconexão GitHub não foi entregue')
    )
  })

  it('conexão legada sem refresh token guardado E com access_token já vencido: avisa o dono, sem tentar renovar', async () => {
    // Achado Crítico 1 (Task 5/F8): "sem refresh token" só justifica avisar
    // o dono quando o access_token atual JÁ venceu — sem isso não há como
    // renovar sozinho de verdade. expiresAt no passado é o que torna este
    // caso genuinamente "precisa reconectar" (ver o par de testes em
    // github-token-refresh.test.ts para o caso "ainda válido").
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
          expiresAt: new Date(AGORA.getTime() - 1000),
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
          expiresAt: new Date(AGORA.getTime() - 1000),
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

    // `falhasDeDecifragem`/`falhasTransitorias`/`legadosSemAcao` foram
    // acrescentados à interface ResumoDaRenovacaoGithub pelas correções da
    // revisão da Task 5/F8 — todos obrigatórios (sem `?`), precisam
    // aparecer aqui zerados, senão o objeto retornado nunca bateria com o
    // tipo real de retorno da função.
    expect(resumo).toEqual({
      renovados: 0,
      precisamReconectar: 0,
      falhasDeDecifragem: 0,
      falhasTransitorias: 0,
      legadosSemAcao: 0,
    })
    expect(findMany).not.toHaveBeenCalled()
  })

  // Achado Crítico 2 + Alto 4 (Task 5/F8), no WIRING completo (scheduler.ts):
  // prova que a composição real (decryptCredential de verdade +
  // trocarRefreshTokenNoGithub, do jeito que renovarTokensGithubDoRelogio de
  // fato monta em produção — Prisma/Telegram mockados, cripto e decisão
  // reais) classifica uma falha de decifragem como problema NOSSO, nunca
  // como "cliente precisa reconectar". O caso específico de
  // GITORCH_CREDENTIAL_KEY ausente/malformada (o bug exato do loadKey() do
  // achado Crítico 2) tem teste dedicado e mais preciso em
  // github-token-refresh.test.ts ("composição real, sem depender do
  // wiring") — aqui não dá para simular "chave ausente" sem também derrubar
  // o processo em getEnv(), já que GITORCH_CREDENTIAL_KEY virou obrigatória
  // no schema de env (config/env.ts). Este teste cobre a variante que É
  // segura de simular no wiring completo: uma instância já rodando com a
  // chave NOVA (rotação com propagação incompleta) tentando ler um dado
  // cifrado com a chave ANTIGA.
  it('composição REAL (decrypt de verdade): chave trocada na rotação faz o dado não decifrar — conta como falhasDeDecifragem, NUNCA marca needs_reconnect nem notifica', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      throw new Error(`fetch inesperado (não deveria chamar rede nenhuma): ${href}`)
    }) as unknown as typeof fetch

    const refreshCifradoComChaveAntiga = encryptCredential('refresh_plano_antigo')
    // Troca a chave DEPOIS de cifrar (chave nova, formato válido, valor
    // diferente) — a mesma situação de uma instância que já recebeu a
    // rotação enquanto o dado no banco ainda foi cifrado com a antiga.
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    resetEnvCache()

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_chave_rotacionada',
          encryptedRefreshToken: refreshCifradoComChaveAntiga,
          expiresAt: new Date(AGORA.getTime() + 5 * 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      updateMany,
      telegramLink: { status: 'linked', chatId: 'chat_chave_rotacionada' },
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.falhasDeDecifragem).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })

  // Achado Crítico 1, na composição real: o deploy desta fase não pode
  // derrubar conexões existentes só porque a coluna de refresh token é
  // nova. Prova, através do wiring de verdade (não só a função pura), que
  // uma conexão legada com token ainda válido não é tocada.
  it('conexão legada sem refresh token, mas com access_token ainda válido: NÃO marca needs_reconnect, NÃO notifica, e não chama o GitHub', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      throw new Error(`fetch inesperado (não deveria chamar rede nenhuma): ${href}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_legado_ainda_bom',
          encryptedRefreshToken: null,
          expiresAt: new Date(AGORA.getTime() + 6 * 60 * 60 * 1000),
          refreshTokenExpiresAt: null,
        },
      ],
      updateMany,
      telegramLink: { status: 'linked', chatId: 'chat_legado_bom' },
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.legadosSemAcao).toBe(1)
    expect(resumo.precisamReconectar).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })

  // Achado Alto 2 (Task 5/F8): ANTES desta correção, a troca com o GitHub
  // não carregava NENHUM signal — uma chamada pendurada travava para
  // sempre. Este teste prova o WIRING (que scheduler.ts monta
  // `fetchImpl: fetchComTeto(fetch)`, não `fetch` cru): a chamada real ao
  // GitHub tem que carregar um AbortSignal não abortado. O mecanismo de
  // timeout em si (que um signal desse tipo de fato aborta dentro do teto)
  // já está provado em fetch-com-teto.test.ts e na composição de
  // services/github-token-refresh.test.ts — aqui só se prova que scheduler.ts
  // de fato liga os dois.
  it('achado Alto 2: a chamada real ao GitHub carrega um AbortSignal (fetchComTeto) — antes desta correção, nenhum signal era passado', async () => {
    const refreshCifrado = encryptCredential('refresh_plano_abc')
    let signalCapturado: AbortSignal | undefined
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href === 'https://github.com/login/oauth/access_token') {
        signalCapturado = init?.signal ?? undefined
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

    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_teto',
          encryptedRefreshToken: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 10 * 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
    })

    await renovarTokensGithubDoRelogio(app, AGORA)

    expect(signalCapturado).toBeInstanceOf(AbortSignal)
    expect(signalCapturado?.aborted).toBe(false)
  })

  // Achado ⚠️ CRÍTICO A VERIFICAR (revisão do Baixo 6): a URL desta
  // notificação embute o TOKEN DO BOT no próprio caminho
  // (`https://api.telegram.org/bot<token>/sendMessage`). Investigação real
  // (Node 20 / undici, ver o comentário em scheduler.ts) não reproduziu a
  // URL em nenhum campo do erro produzido hoje — mas este teste não confia
  // nisso: simula o PIOR CASO deliberado, um fetchImpl cujo erro EMBUTE a
  // URL completa (com o token) na própria mensagem — o jeito que "algumas
  // implementações de fetch" fazem — e prova que, mesmo assim, nada do que
  // chega em `app.log.warn` carrega o token nem o host do Telegram.
  it('achado ⚠️ CRÍTICO: falha de entrega do Telegram com um erro que EMBUTIRIA a URL/token (pior caso) — o log nunca recebe o objeto de erro cru', async () => {
    const refreshCifrado = encryptCredential('refresh_plano_revogado')
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 401 })
      }
      if (href.startsWith('https://api.telegram.org/bot')) {
        throw new Error(`request to ${href} failed, reason: ECONNREFUSED`)
      }
      throw new Error(`fetch inesperado: ${href}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_pior_caso',
          encryptedRefreshToken: refreshCifrado,
          expiresAt: new Date(AGORA.getTime() + 5 * 60 * 1000),
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
      updateMany,
      telegramLink: { status: 'linked', chatId: 'chat_pior_caso' },
    })

    await renovarTokensGithubDoRelogio(app, AGORA)

    const chamadaDeEntregaFalha = (app.log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (chamada: unknown[]) =>
        typeof chamada[1] === 'string' &&
        (chamada[1] as string).includes('aviso de reconexão GitHub não foi entregue')
    )

    expect(chamadaDeEntregaFalha).toBeDefined()
    expect(algumaPropriedadeContemTexto(chamadaDeEntregaFalha![0], 'bot-token-teste')).toBe(false)
    expect(algumaPropriedadeContemTexto(chamadaDeEntregaFalha![0], 'api.telegram.org')).toBe(false)
  })

  // Achado Baixo 5 (Task 5/F8): ANTES desta correção, o retorno de
  // renovarTokensGithubDoRelogio era descartado pelo chamador (tick()) e o
  // único rastro era um `onWarn` (app.log.warn) POR CONEXÃO legada, EM TODO
  // TIQUE — com N conexões legadas ainda válidas, N linhas de log
  // idênticas, sem dedupe, a cada minuto. Este teste prova as DUAS metades
  // do conserto no wiring real: (1) app.log.warn NUNCA é chamado para essas
  // conexões; (2) app.log.info é chamado exatamente UMA vez, com o resumo
  // inteiro da passada (legadosSemAcao incluso) — não uma vez por conexão.
  it('achado Baixo 5: várias conexões legadas ainda válidas numa passada geram UMA linha de resumo (app.log.info), nunca um aviso por conexão', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      throw new Error(`fetch inesperado (não deveria chamar rede nenhuma): ${String(url)}`)
    }) as unknown as typeof fetch

    const updateMany = vi.fn(async () => ({ count: 1 }))
    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_legado_1',
          encryptedRefreshToken: null,
          expiresAt: new Date(AGORA.getTime() + 6 * 60 * 60 * 1000),
          refreshTokenExpiresAt: null,
        },
        {
          userId: 'user_legado_2',
          encryptedRefreshToken: null,
          expiresAt: new Date(AGORA.getTime() + 7 * 60 * 60 * 1000),
          refreshTokenExpiresAt: null,
        },
        {
          userId: 'user_legado_3',
          encryptedRefreshToken: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
        },
      ],
      updateMany,
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo.legadosSemAcao).toBe(3)
    expect(app.log.warn).not.toHaveBeenCalled()
    expect(app.log.info).toHaveBeenCalledTimes(1)
    expect(app.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ legadosSemAcao: 3 }),
      expect.stringContaining('renovação de token GitHub')
    )
  })

  it('achado Baixo 5: passada sem NENHUMA atividade (todos os contadores zerados) não gera linha de resumo nenhuma', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      throw new Error(`fetch inesperado (não deveria chamar rede nenhuma): ${String(url)}`)
    }) as unknown as typeof fetch

    const app = fakeApp({
      conexoes: [
        {
          userId: 'user_tranquilo',
          encryptedRefreshToken: 'envelope-qualquer',
          expiresAt: new Date(AGORA.getTime() + 6 * 60 * 60 * 1000), // longe do vencimento
          refreshTokenExpiresAt: new Date(AGORA.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      ],
    })

    const resumo = await renovarTokensGithubDoRelogio(app, AGORA)

    expect(resumo).toEqual({
      renovados: 0,
      precisamReconectar: 0,
      falhasDeDecifragem: 0,
      falhasTransitorias: 0,
      legadosSemAcao: 0,
    })
    expect(app.log.info).not.toHaveBeenCalled()
    expect(app.log.warn).not.toHaveBeenCalled()
  })
})
