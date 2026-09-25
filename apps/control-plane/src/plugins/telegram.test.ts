import { describe, it, expect, vi } from 'vitest'
import {
  projetoTemRepositorioValido,
  acordarSmComSeguranca,
  processarComandoWishlistAdd,
} from './telegram.js'
import * as wishlistService from '../lib/wishlist-service.js'

/**
 * Fix-up (revisão) do defeito 4: dentro de `aoResponderDuvidaDoDev` (o
 * manipulador do prefixo `duvida-dev:`), o `comentarNaIssue` injetado em
 * `retomar-sessao-com-resposta.ts` buscava o projeto (`app.prisma.project.
 * findUnique`) e só validava `!projeto` — nunca `!projeto.wingId`. Um
 * projeto achado mas com `wingId` nulo/vazio (registro corrompido/legado)
 * seguia direto para `criarComentarNaIssue({ repository: projeto.wingId,
 * ... })`, montando `https://api.github.com/repos/<vazio>/issues/...` — uma
 * URL inválida que só estoura (com um erro confuso, 404 do GitHub) várias
 * chamadas depois, em vez de um aviso claro no ponto onde o dado já se
 * mostrou ruim.
 *
 * `projetoTemRepositorioValido` é o predicado extraído para ser testável
 * isoladamente (mesmo padrão de `criarComentarNaIssue`,
 * `parseDedupKeyDeDuvidaDoDev`) — sem montar o plugin Fastify inteiro.
 */
describe('projetoTemRepositorioValido', () => {
  it('projeto com wingId de verdade ("dono/repo"): válido', () => {
    expect(projetoTemRepositorioValido({ wingId: 'acme/api' })).toBe(true)
  })

  it('projeto inexistente (null): inválido', () => {
    expect(projetoTemRepositorioValido(null)).toBe(false)
  })

  it('projeto com wingId nulo: inválido — é EXATAMENTE o defeito medido (URL com "null")', () => {
    expect(projetoTemRepositorioValido({ wingId: null })).toBe(false)
  })

  it('projeto com wingId undefined: inválido', () => {
    expect(projetoTemRepositorioValido({ wingId: undefined })).toBe(false)
  })

  it('projeto com wingId vazio ou só espaço: inválido', () => {
    expect(projetoTemRepositorioValido({ wingId: '' })).toBe(false)
    expect(projetoTemRepositorioValido({ wingId: '   ' })).toBe(false)
  })
})

/**
 * DJ-T3b (revisão): dentro de `aoResponderDuvidaDoDev`,
 * `app.acordarSmPorVagaLiberada(...)` era chamado sem guarda, DEPOIS de a
 * retomada já ter acontecido — se o decorator não estiver registrado (ordem
 * de plugins, scheduler desligado, teste de rota isolado) o `TypeError`
 * derrubava a resposta ao dono mesmo com a retomada já entregue.
 * `acordarSmComSeguranca` isola essa chamada (mesmo padrão de
 * `projetoTemRepositorioValido`: extraído para ser testável sem montar o
 * plugin Fastify inteiro).
 */
describe('acordarSmComSeguranca', () => {
  it('decorator ausente: não lança', () => {
    const app = { log: { warn: vi.fn() } } as unknown as Parameters<typeof acordarSmComSeguranca>[0]
    expect(() => acordarSmComSeguranca(app, 'proj_1', 'dúvida do dev respondida')).not.toThrow()
  })

  it('decorator presente: chamado uma vez com o projectId e o motivo', () => {
    const acordar = vi.fn()
    const app = {
      acordarSmPorVagaLiberada: acordar,
      log: { warn: vi.fn() },
    } as unknown as Parameters<typeof acordarSmComSeguranca>[0]

    acordarSmComSeguranca(app, 'proj_1', 'dúvida do dev respondida')

    expect(acordar).toHaveBeenCalledTimes(1)
    expect(acordar).toHaveBeenCalledWith('proj_1', 'dúvida do dev respondida')
  })

  it('decorator que lança: não propaga — só loga aviso', () => {
    const warn = vi.fn()
    const app = {
      acordarSmPorVagaLiberada: vi.fn(() => {
        throw new Error('boom')
      }),
      log: { warn },
    } as unknown as Parameters<typeof acordarSmComSeguranca>[0]

    expect(() => acordarSmComSeguranca(app, 'proj_1', 'dúvida do dev respondida')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('processarComandoWishlistAdd', () => {
  it('rejeita payload vazio', async () => {
    const sendMsg = vi.fn()
    const app = {
      prisma: {} as Parameters<typeof processarComandoWishlistAdd>[2]['prisma'],
      log: { error: vi.fn() },
    }

    await processarComandoWishlistAdd({ userId: 'u1' }, '   ', app, sendMsg)

    expect(sendMsg).toHaveBeenCalledWith('Use /wishlist add <item>')
  })

  it('adiciona o item, chama o serviço e emite o SSE', async () => {
    const sendMsg = vi.fn()
    const broadcastEvent = vi.fn()
    const app = {
      prisma: {} as Parameters<typeof processarComandoWishlistAdd>[2]['prisma'],
      log: { error: vi.fn() },
      broadcastEvent,
    }

    const spy = vi.spyOn(wishlistService, 'addItemToWishlist').mockResolvedValueOnce({
      id: 'w1',
      userId: 'u1',
      payload: 'teste do bot',
      source: 'telegram',
        targetRepositoryIds: [],
        isCrossRepo: false,
      createdAt: new Date(),
    })

    await processarComandoWishlistAdd({ userId: 'u1' }, ' teste do bot ', app, sendMsg)

    expect(spy).toHaveBeenCalledWith('u1', 'teste do bot', 'telegram', {
      prisma: app.prisma,
      broadcastEvent: app.broadcastEvent,
    })
    expect(sendMsg).toHaveBeenCalledWith('Item adicionado à wishlist com sucesso.')
  })

  it('captura erros e não avisa sucesso ou omite erro silencioso', async () => {
    const sendMsg = vi.fn()
    const broadcastEvent = vi.fn()
    const logError = vi.fn()
    const app = {
      prisma: {} as Parameters<typeof processarComandoWishlistAdd>[2]['prisma'],
      log: { error: logError },
      broadcastEvent,
    }

    const spy = vi
      .spyOn(wishlistService, 'addItemToWishlist')
      .mockRejectedValueOnce(new Error('banco falhou'))

    await processarComandoWishlistAdd({ userId: 'u1' }, ' falho ', app, sendMsg)

    expect(spy).toHaveBeenCalled()
    expect(broadcastEvent).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
    expect(sendMsg).toHaveBeenCalledWith('Ocorreu um erro ao adicionar à wishlist.')
  })
})
