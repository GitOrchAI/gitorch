import { describe, it, expect } from 'vitest'
import {
  julesSourceName,
  criarSessaoJules,
  numeroDoPrDaSaida,
  consultarSessaoJules,
  responderSessaoJules,
  aprovarPlanoJules,
} from './jules-client.js'
import * as julesClient from './jules-client.js'

// Desejo do dono (issue de wishlist deste repositório): delegar tem de ACIONAR
// o dev assíncrono, não apenas pendurar um label e torcer para alguém escutar.
//
// Medido antes desta mudança: o SM delegou (label aplicado numa issue P0),
// passaram-se 13 missões e nenhum PR apareceu — o repositório sequer estava
// conectado na conta do serviço. O label é uma campainha muda; a sessão criada
// pela API tem identificador, e identificador dá para acompanhar e cobrar.

describe('julesSourceName', () => {
  it('traduz dono/repo para o identificador que a API espera', () => {
    expect(julesSourceName('GitOrchAI/gitorch')).toBe('sources/github/GitOrchAI/gitorch')
  })

  it('repositório malformado não vira chamada', () => {
    expect(julesSourceName('sem-barra')).toBeNull()
    expect(julesSourceName('')).toBeNull()
  })
})

describe('criarSessaoJules', () => {
  const fetchFake = (respostas: Array<{ ok: boolean; status: number; body: unknown }>) => {
    const chamadas: Array<{ url: string; init: RequestInit | undefined }> = []
    let i = 0
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push({ url: String(url), init })
      const r = respostas[Math.min(i++, respostas.length - 1)]!
      return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response
    }) as unknown as typeof fetch
    return { impl, chamadas }
  }

  const base = {
    apiKey: 'chave',
    repository: 'GitOrchAI/gitorch',
    startingBranch: 'main',
    titulo: '[Task] Corrigir emissão de token',
    prompt: '## Goal\n\nGarantir que o token alcance o repositório.',
  }

  // ACHADO 1 do QA: o vigia do pull request órfão precisa que o trabalho volte
  // para o ramo DO PULL REQUEST, e não para um ramo novo saído da principal.
  //
  // Contrato conferido AO VIVO em 31/08/2026 contra jules.googleapis.com, sem
  // criar sessão nenhuma (fonte inexistente de propósito):
  //   campo inventado           → HTTP 400 "Unknown name ... Cannot find field"
  //   sourceContext.workingBranch → passou a validação, HTTP 404 na fonte
  //   automationMode inventado  → HTTP 400 "Invalid value ... AutomationMode"
  // Ou seja: `workingBranch` existe, e AUTO_CREATE_PR é o único modo além do
  // não-especificado. É por `workingBranch` que a entrega volta ao mesmo ramo.
  it('quando pedem um ramo de trabalho, ele viaja em sourceContext.workingBranch', async () => {
    const { impl, chamadas } = fetchFake([
      { ok: true, status: 200, body: { name: 'sessions/abc123' } },
    ])

    await criarSessaoJules({
      ...base,
      startingBranch: 'ramo-do-pr-356',
      workingBranch: 'ramo-do-pr-356',
      fetchImpl: impl,
    })

    const corpo = JSON.parse(String(chamadas[0]!.init!.body))
    expect(corpo.sourceContext.githubRepoContext.startingBranch).toBe('ramo-do-pr-356')
    expect(corpo.sourceContext.workingBranch).toBe('ramo-do-pr-356')
  })

  it('sem ramo de trabalho, `workingBranch` NÃO é enviado (o Jules escolhe um)', async () => {
    const { impl, chamadas } = fetchFake([
      { ok: true, status: 200, body: { name: 'sessions/abc123' } },
    ])

    await criarSessaoJules({ ...base, fetchImpl: impl })

    const corpo = JSON.parse(String(chamadas[0]!.init!.body))
    expect('workingBranch' in corpo.sourceContext).toBe(false)
  })

  it('cria a sessão com o repositório, o branch e o pedido de PR automático', async () => {
    const { impl, chamadas } = fetchFake([
      { ok: true, status: 200, body: { name: 'sessions/abc123' } },
    ])

    const sessao = await criarSessaoJules({ ...base, fetchImpl: impl })

    expect(sessao).toEqual({ situacao: 'criada', sessionName: 'sessions/abc123' })
    const req = chamadas[0]!
    expect(req.url).toContain('/v1alpha/sessions')
    expect((req.init!.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('chave')
    const corpo = JSON.parse(String(req.init!.body))
    expect(corpo.sourceContext.source).toBe('sources/github/GitOrchAI/gitorch')
    expect(corpo.sourceContext.githubRepoContext.startingBranch).toBe('main')
    expect(corpo.automationMode).toBe('AUTO_CREATE_PR')
    expect(corpo.prompt).toContain('Goal')
    expect(corpo.title).toContain('Corrigir emissão de token')
  })

  it('sem chave configurada: DESLIGADO, não é falha — o label segue como plano B', async () => {
    // A distinção é o conserto de 22/08/2026: 'desligado' e 'falhou' não podem
    // voltar iguais. Quem chama precisa saber se segue com o plano B ou se dá
    // meia-volta e deixa a issue por fazer.
    const { impl, chamadas } = fetchFake([{ ok: true, status: 200, body: {} }])
    const sessao = await criarSessaoJules({ ...base, apiKey: undefined, fetchImpl: impl })

    expect(sessao).toEqual({ situacao: 'desligado' })
    expect(chamadas).toHaveLength(0)
  })

  it('repositório não conectado na conta: avisa o que fazer, sem quebrar a delegação', async () => {
    const avisos: string[] = []
    const { impl } = fetchFake([
      { ok: false, status: 404, body: { error: { message: 'source not found' } } },
    ])

    const sessao = await criarSessaoJules({
      ...base,
      fetchImpl: impl,
      onWarn: (m) => avisos.push(m),
    })

    expect(sessao.situacao).toBe('falhou')
    // O motivo VOLTA junto, não só no log: é ele que vai parar no comentário
    // da issue para quem cuida do quadro entender por que ela não andou.
    expect(sessao).toMatchObject({ motivo: expect.stringContaining('GitOrchAI/gitorch') })
    expect(avisos.join(' ')).toContain('GitOrchAI/gitorch')
    expect(avisos.join(' ').toLowerCase()).toContain('conect')
  })

  it('serviço fora do ar nunca derruba o trabalho do SM', async () => {
    const avisos: string[] = []
    const impl = (async () => {
      throw new Error('rede caiu')
    }) as unknown as typeof fetch

    const sessao = await criarSessaoJules({
      ...base,
      fetchImpl: impl,
      onWarn: (m) => avisos.push(m),
    })
    expect(sessao).toEqual({ situacao: 'falhou', motivo: 'rede caiu' })
    expect(avisos.length).toBeGreaterThan(0)
  })
})

describe('numeroDoPrDaSaida', () => {
  it('extrai o número do PR da saída da sessão', () => {
    expect(
      numeroDoPrDaSaida([{ pullRequest: { url: 'https://github.com/dono/repo/pull/63' } }])
    ).toBe(63)
  })

  it('endereço fora do formato esperado não vira número', () => {
    // Sem a âncora de fim, ".../pull/63x" e ".../pull/63.qualquer-coisa"
    // casariam — e o número extraído apontaria para um PR que não é aquele.
    expect(numeroDoPrDaSaida([{ pullRequest: { url: 'https://exemplo.invalido/x' } }])).toBeNull()
    expect(
      numeroDoPrDaSaida([{ pullRequest: { url: 'https://github.com/dono/repo/pull/63x' } }])
    ).toBeNull()
  })

  it('saída vazia ou de outro formato devolve nulo em vez de explodir', () => {
    expect(numeroDoPrDaSaida(undefined)).toBeNull()
    expect(numeroDoPrDaSaida([])).toBeNull()
    expect(numeroDoPrDaSaida([{ changeSet: {} }])).toBeNull()
  })
})

describe('consultarSessaoJules', () => {
  it('devolve estado e número do PR, sem carregar a URL adiante', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          state: 'COMPLETED',
          updateTime: '2026-01-01T00:00:00Z',
          outputs: [{ pullRequest: { url: 'https://github.com/dono/repo/pull/63' } }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch

    const lido = await consultarSessaoJules({ apiKey: 'k', sessionName: 'sessions/1', fetchImpl })

    expect(lido).toEqual({
      estado: 'COMPLETED',
      numeroDoPr: 63,
      ultimaAtualizacao: '2026-01-01T00:00:00Z',
    })
  })

  it('sem chave configurada, o recurso está desligado — não é erro', async () => {
    expect(await consultarSessaoJules({ sessionName: 'sessions/1' })).toBeNull()
  })

  it('serviço fora do ar avisa e devolve nulo, sem derrubar a vigia', async () => {
    const avisos: string[] = []
    const fetchImpl = (async () => {
      throw new Error('rede caiu')
    }) as unknown as typeof fetch

    const lido = await consultarSessaoJules({
      apiKey: 'k',
      sessionName: 'sessions/1',
      fetchImpl,
      onWarn: (m) => avisos.push(m),
    })

    expect(lido).toBeNull()
    expect(avisos[0]).toContain('sessions/1')
  })
})

describe('responderSessaoJules e aprovarPlanoJules', () => {
  it('a resposta vai no corpo, para o método de mensagem da sessão', async () => {
    let urlChamada = ''
    let corpo = ''
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urlChamada = String(url)
      corpo = String(init.body)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const ok = await responderSessaoJules({
      apiKey: 'k',
      sessionName: 'sessions/1',
      texto: 'siga pelo caminho A',
      fetchImpl,
    })

    expect(ok).toBe(true)
    expect(urlChamada).toContain('sessions/1:sendMessage')
    expect(JSON.parse(corpo)).toEqual({ prompt: 'siga pelo caminho A' })
  })

  it('recusa do serviço não lança: devolve falso e o ciclo seguinte tenta de novo', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch

    expect(await aprovarPlanoJules({ apiKey: 'k', sessionName: 'sessions/1', fetchImpl })).toBe(
      false
    )
  })
})

describe('a superfície do cliente do Jules bate com a API oficial', () => {
  it('não expõe funções que chamam endereços inexistentes', () => {
    // `:continue` e `/quota` não existem na API do Jules (documentação oficial
    // e sondagem: 404). Manter função para eles é código morto disfarçado de
    // funcional — sempre caiu no próprio catch.
    expect(julesClient).not.toHaveProperty('continuarSessaoJules')
    expect(julesClient).not.toHaveProperty('getJulesQuota')
    expect(julesClient).not.toHaveProperty('getSessaoJulesStatus')
  })

  it('expõe as quatro funções que a vigia usa', () => {
    expect(typeof julesClient.consultarSessaoJules).toBe('function')
    expect(typeof julesClient.responderSessaoJules).toBe('function')
    expect(typeof julesClient.aprovarPlanoJules).toBe('function')
    expect(typeof julesClient.ultimaMensagemDoDevJules).toBe('function')
  })
})
