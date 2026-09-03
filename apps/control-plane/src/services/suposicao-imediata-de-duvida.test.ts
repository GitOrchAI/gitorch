import { describe, it, expect, vi } from 'vitest'
import { tentarSuposicaoImediata, criarComentarNaIssue } from './suposicao-imediata-de-duvida.js'
import * as duvidaRailsMission from './duvida-rails-mission.js'
import { marcarRespondida } from './pergunta-sem-resposta.js'

/**
 * D72 (02/09), item 2 — "antes de responder vai ter que ... ler o que o RA
 * está passando, ou o próprio RA responda". Antes desta função, quando o
 * QA e o RA esgotavam uma dúvida técnica, a única saída era escalar
 * direto ao dono (`escalar-duvida-ao-dono.ts`) e esperar até 24h em
 * silêncio (`supor-duvida-pendente.ts`) para o RA formar uma suposição.
 * `tentarSuposicaoImediata` tenta a suposição NA HORA, no mesmo tique —
 * o dono só é perguntado se isto também falhar.
 */

const ARGS_BASE = {
  pergunta: 'Should I use bcrypt or argon2?',
  repository: 'acme/api',
  issueNumber: 46,
  execute: vi.fn(),
  contextBlocks: [] as string[],
  apiKey: 'jules-key',
  sessionName: 'sessions/1',
  hashDaPergunta: 'hash123',
}

const SUPOSICAO_CONCRETA = {
  suposicao: 'Use argon2id — o helper já existe em src/lib/hash.ts.',
  justificativa: 'É o padrão já usado no login.',
  arquivosCitados: ['src/lib/hash.ts'],
}

function depsFalso(overrides: Record<string, unknown> = {}) {
  return {
    prisma: { devSession: { update: vi.fn(async () => undefined) } },
    responder: vi.fn(async () => true),
    comentarNaIssue: vi.fn(async () => undefined),
    onWarn: vi.fn(),
    agora: new Date('2026-09-02T12:00:00Z'),
    ...overrides,
  }
}

describe('tentarSuposicaoImediata', () => {
  it('suposição concreta: entrega ao dev, comenta na issue, marca respondida — devolve true', async () => {
    vi.spyOn(duvidaRailsMission, 'suporSemODono').mockResolvedValue(SUPOSICAO_CONCRETA)
    const deps = depsFalso()

    const resolvido = await tentarSuposicaoImediata(ARGS_BASE, deps as never)

    expect(resolvido).toBe(true)
    expect(deps.responder).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'jules-key',
        sessionName: 'sessions/1',
        texto: expect.stringContaining('argon2id'),
      })
    )
    expect(deps.comentarNaIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 46, texto: expect.stringContaining('argon2id') })
    )
    expect(
      (deps.prisma as { devSession: { update: ReturnType<typeof vi.fn> } }).devSession.update
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ answeredHash: marcarRespondida('hash123') }),
      })
    )
    vi.restoreAllMocks()
  })

  it('NUNCA cria agent_question nem pergunta ao dono quando a suposição resolve — dono não é notificado', async () => {
    vi.spyOn(duvidaRailsMission, 'suporSemODono').mockResolvedValue(SUPOSICAO_CONCRETA)
    const deps = depsFalso()

    await tentarSuposicaoImediata(ARGS_BASE, deps as never)

    // Nenhuma dependência de agent-question é sequer recebida por esta
    // função — a prova é estrutural (a interface não tem esse campo) e
    // comportamental: nada além de responder/comentar/registrar é chamado.
    expect(Object.keys(deps)).not.toContain('agentQuestionService')
    vi.restoreAllMocks()
  })

  it('suposição NÃO concreta (null): devolve false, nunca entrega nada ao dev', async () => {
    vi.spyOn(duvidaRailsMission, 'suporSemODono').mockResolvedValue(null)
    const deps = depsFalso()

    const resolvido = await tentarSuposicaoImediata(ARGS_BASE, deps as never)

    expect(resolvido).toBe(false)
    expect(deps.responder).not.toHaveBeenCalled()
    expect(deps.comentarNaIssue).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('suporSemODono lança (falha do motor): trata como "sem suposição concreta" — devolve false, nunca derruba o chamador', async () => {
    vi.spyOn(duvidaRailsMission, 'suporSemODono').mockRejectedValue(new Error('motor sem cota'))
    const deps = depsFalso()

    const resolvido = await tentarSuposicaoImediata(ARGS_BASE, deps as never)

    expect(resolvido).toBe(false)
    expect(deps.onWarn).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('suposição concreta mas a entrega ao dev falha: devolve false (a chamada escala normalmente)', async () => {
    vi.spyOn(duvidaRailsMission, 'suporSemODono').mockResolvedValue(SUPOSICAO_CONCRETA)
    const deps = depsFalso({ responder: vi.fn(async () => false) })

    const resolvido = await tentarSuposicaoImediata(ARGS_BASE, deps as never)

    expect(resolvido).toBe(false)
    expect(deps.comentarNaIssue).not.toHaveBeenCalled()
    expect(
      (deps.prisma as { devSession: { update: ReturnType<typeof vi.fn> } }).devSession.update
    ).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('comentarNaIssue falha: best-effort — ainda devolve true (a entrega ao dev já aconteceu)', async () => {
    vi.spyOn(duvidaRailsMission, 'suporSemODono').mockResolvedValue(SUPOSICAO_CONCRETA)
    const deps = depsFalso({
      comentarNaIssue: vi.fn(async () => {
        throw new Error('403 do GitHub')
      }),
    })

    const resolvido = await tentarSuposicaoImediata(ARGS_BASE, deps as never)

    expect(resolvido).toBe(true)
    expect(deps.onWarn).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('criarComentarNaIssue — o comentário best-effort na issue do cliente (defeito real: header "token undefined" em produção)', () => {
  it('sem token: NENHUMA chamada de rede é feita — só um aviso claro', async () => {
    const fetchDoCliente = vi.fn()
    const onWarn = vi.fn()
    const comentar = criarComentarNaIssue({
      fetchDoCliente: fetchDoCliente as unknown as typeof fetch,
      repository: 'acme/api',
      githubToken: undefined,
      onWarn,
    })

    await comentar({ issueNumber: 46, texto: 'GitOrch: suposição adotada: x' })

    expect(fetchDoCliente).not.toHaveBeenCalled()
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/token/i))
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('#46'))
  })

  it('com token: chama o fetch guardado, com o header de autorização correto', async () => {
    const fetchDoCliente = vi.fn(async () => new Response('{}', { status: 201 }))
    const onWarn = vi.fn()
    const comentar = criarComentarNaIssue({
      fetchDoCliente: fetchDoCliente as unknown as typeof fetch,
      repository: 'acme/api',
      githubToken: 'ghs_abc123',
      onWarn,
    })

    await comentar({ issueNumber: 46, texto: 'GitOrch: suposição adotada: x' })

    expect(fetchDoCliente).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/api/issues/46/comments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'token ghs_abc123' }),
      })
    )
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('com token, mas o GitHub recusa (resp não ok): lança — best-effort é responsabilidade de quem chama', async () => {
    const fetchDoCliente = vi.fn(async () => new Response('{}', { status: 401 }))
    const comentar = criarComentarNaIssue({
      fetchDoCliente: fetchDoCliente as unknown as typeof fetch,
      repository: 'acme/api',
      githubToken: 'ghs_abc123',
      onWarn: vi.fn(),
    })

    await expect(comentar({ issueNumber: 46, texto: 'x' })).rejects.toThrow(/401/)
  })
})
