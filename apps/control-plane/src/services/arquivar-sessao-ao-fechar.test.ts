import { describe, expect, it, vi } from 'vitest'
import { fecharSessao } from './dev-session-store.js'
import { arquivarSessaoJules } from './jules-client.js'
import type { PrismaDevSession } from './dev-session-store.js'

// POR QUE ESTE ARQUIVO EXISTE — vazamento medido em produção, 21/08/2026.
//
// O produto criava conversa com o dev assíncrono e NUNCA a encerrava do lado
// do fornecedor: `fecharSessao` só apagava a linha da vigília AQUI. Lá fora a
// sessão seguia viva, segurando uma vaga, para sempre.
//
// O que isso produziu, medido: onze recusas de criação de sessão com
// `FAILED_PRECONDITION` num único dia, e as dezoito vagas ativas do fornecedor
// ocupadas — todas em "esperando resposta". Cada delegação consumia uma vaga em
// definitivo, então a esteira inteira tinha prazo de validade: bastava delegar
// o suficiente para nunca mais delegar.
//
// O sintoma era MUDO. A issue recebia a etiqueta de delegada e nada acontecia.

function prismaFalso() {
  const update = vi.fn(async () => undefined)
  return { prisma: { devSession: { update } } as unknown as PrismaDevSession, update }
}

const AGORA = new Date('2026-08-21T21:00:00Z')

describe('fecharSessao também encerra a conversa no fornecedor', () => {
  it('arquiva no fornecedor ANTES de apagar a linha da vigília', async () => {
    const { prisma, update } = prismaFalso()
    const ordem: string[] = []
    const arquivar = vi.fn(async () => {
      ordem.push('arquivou')
      return true
    })
    update.mockImplementation(async () => {
      ordem.push('fechou')
      return undefined
    })

    await fecharSessao({
      prisma,
      sessionName: 'sessions/123',
      motivo: 'merged',
      agora: AGORA,
      arquivarNoFornecedor: arquivar,
    })

    expect(arquivar).toHaveBeenCalledWith('sessions/123')
    // A ordem é o ponto: fechar primeiro e falhar no arquivamento deixaria a
    // vaga presa sem ninguém saber que ela existiu — a linha some daqui e a
    // conversa continua viva lá fora.
    expect(ordem).toEqual(['arquivou', 'fechou'])
  })

  it('quando o arquivamento falha, avisa com o nome da sessão e AINDA fecha a linha', async () => {
    const { prisma, update } = prismaFalso()
    const avisos: string[] = []

    await fecharSessao({
      prisma,
      sessionName: 'sessions/presa',
      motivo: 'abandoned',
      agora: AGORA,
      arquivarNoFornecedor: async () => false,
      onWarn: (m) => avisos.push(m),
    })

    // Barulhento e com o nome dentro: é por ele que a varredura de
    // reconciliação — e uma pessoa, se precisar — acha a vaga presa.
    expect(avisos.some((m) => m.includes('sessions/presa'))).toBe(true)
    // A entrega de fato terminou; represar o registro faria o quadro mentir ao
    // contrário. A vaga presa é tratada pela reconciliação, não segurando isto.
    expect(update).toHaveBeenCalledOnce()
  })

  it('arquivador que LANÇA não derruba o fechamento', async () => {
    const { prisma, update } = prismaFalso()
    const avisos: string[] = []

    await fecharSessao({
      prisma,
      sessionName: 'sessions/explode',
      motivo: 'failed_final',
      agora: AGORA,
      arquivarNoFornecedor: async () => {
        throw new Error('rede fora do ar')
      },
      onWarn: (m) => avisos.push(m),
    })

    expect(avisos.some((m) => m.includes('sessions/explode'))).toBe(true)
    expect(update).toHaveBeenCalledOnce()
  })

  it('sem arquivador injetado, o comportamento antigo é preservado', async () => {
    const { prisma, update } = prismaFalso()
    await fecharSessao({
      prisma,
      sessionName: 'sessions/456',
      motivo: 'merged',
      agora: AGORA,
    })
    expect(update).toHaveBeenCalledOnce()
  })
})

describe('arquivarSessaoJules', () => {
  it('chama o método :archive da sessão', async () => {
    const chamadas: Array<[string, RequestInit | undefined]> = []
    const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push([url, init])
      return new Response('{}', { status: 200 })
    })

    const ok = await arquivarSessaoJules({
      apiKey: 'chave-de-teste',
      sessionName: 'sessions/789',
      fetchImpl: fetchFalso as unknown as typeof fetch,
    })

    expect(ok).toBe(true)
    expect(chamadas[0]?.[0]).toContain('sessions/789:archive')
    expect(chamadas[0]?.[1]?.method).toBe('POST')
  })

  it('recusa do fornecedor devolve false e avisa — nunca lança', async () => {
    const avisos: string[] = []
    const ok = await arquivarSessaoJules({
      apiKey: 'chave-de-teste',
      sessionName: 'sessions/789',
      fetchImpl: (async () => new Response('erro', { status: 429 })) as unknown as typeof fetch,
      onWarn: (m) => avisos.push(m),
    })
    expect(ok).toBe(false)
    expect(avisos.some((m) => m.includes('429'))).toBe(true)
  })

  it('sem credencial não tenta nada', async () => {
    const fetchFalso = vi.fn()
    const ok = await arquivarSessaoJules({
      sessionName: 'sessions/789',
      fetchImpl: fetchFalso as unknown as typeof fetch,
    })
    expect(ok).toBe(false)
    expect(fetchFalso).not.toHaveBeenCalled()
  })
})
