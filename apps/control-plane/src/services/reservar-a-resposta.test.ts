import { describe, it, expect, vi } from 'vitest'
import {
  reservarAResposta,
  devolverAReserva,
  type PrismaParaReserva,
} from './reservar-a-resposta.js'
import { marcarTentativa } from './pergunta-sem-resposta.js'

/**
 * Um banco de mentira que se comporta como o de verdade no que importa aqui:
 * `updateMany` só escreve se a marca no `where` ainda for a que está lá — é a
 * escrita condicional que resolve a corrida.
 */
function bancoFalso(marcaInicial: string | null) {
  let marca = marcaInicial
  const escritas: string[] = []
  const prisma: PrismaParaReserva = {
    devSession: {
      updateMany: vi.fn(async ({ where, data }) => {
        const esperada = (where as { answeredHash: string | null }).answeredHash
        if (marca !== esperada) return { count: 0 }
        marca = (data as { answeredHash: string }).answeredHash
        escritas.push(marca)
        return { count: 1 }
      }),
    },
  }
  return {
    prisma,
    escritas,
    get marca() {
      return marca
    },
  }
}

const COMUM = { sessionName: 'sessions/1', hashDaPergunta: 'p1', tentativa: 1, agora: new Date() }

describe('reservarAResposta — só um responde', () => {
  it('quem chega primeiro reserva', async () => {
    const b = bancoFalso(null)
    expect(await reservarAResposta({ ...COMUM, prisma: b.prisma, marcaLida: null })).toBe(true)
    expect(b.marca).toBe(marcarTentativa('p1', 1))
  })

  it('DOIS ao mesmo tempo, lendo a MESMA marca: só um passa', async () => {
    // É o caso real: duas acordadas do QA caem na mesma janela, leem a marca
    // antiga, e as duas achavam que podiam responder. O dev recebeu a mesma
    // resposta duas vezes no mesmo minuto.
    const b = bancoFalso(null)
    const [um, dois] = await Promise.all([
      reservarAResposta({ ...COMUM, prisma: b.prisma, marcaLida: null }),
      reservarAResposta({ ...COMUM, prisma: b.prisma, marcaLida: null }),
    ])
    expect([um, dois].filter(Boolean)).toHaveLength(1)
    expect(b.escritas).toHaveLength(1)
  })

  it('quem perdeu a corrida sai sem gastar motor', async () => {
    const b = bancoFalso(marcarTentativa('p1', 1))
    // Leu a marca antiga (null), mas alguém já escreveu no meio do caminho.
    expect(await reservarAResposta({ ...COMUM, prisma: b.prisma, marcaLida: null })).toBe(false)
  })

  it('a reserva grava a TENTATIVA certa — é ela que segura o teto', async () => {
    const b = bancoFalso(marcarTentativa('p1', 1))
    await reservarAResposta({
      ...COMUM,
      tentativa: 2,
      prisma: b.prisma,
      marcaLida: marcarTentativa('p1', 1),
    })
    expect(b.marca).toBe(marcarTentativa('p1', 2))
  })

  it('marca nula no banco casa com marca nula lida — sessão que nunca perguntou antes', async () => {
    const b = bancoFalso(null)
    expect(await reservarAResposta({ ...COMUM, prisma: b.prisma, marcaLida: null })).toBe(true)
  })
})

describe('devolverAReserva — motor sem cota não queima a tentativa', () => {
  it('devolve a marca ANTERIOR quando a reserva ainda é minha', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const devolveu = await devolverAReserva({
      prisma: { devSession: { updateMany } } as never,
      sessionName: 'sessions/1',
      hashDaPergunta: 'abc123',
      tentativa: 2,
      marcaAnterior: 'tentando:1:abc123',
      agora: new Date('2026-08-26T22:00:00Z'),
    })
    expect(devolveu).toBe(true)
    const [arg] = updateMany.mock.calls[0] as unknown as [
      {
        where: { sessionName: string; answeredHash: string | null }
        data: { answeredHash: string | null }
      },
    ]
    // Condicional à MINHA marca: se outra acordada já escreveu por cima, ela é
    // a dona e devolver seria ressuscitar um estado que deixou de valer.
    expect(arg.where.answeredHash).toBe('tentando:2:abc123')
    expect(arg.data.answeredHash).toBe('tentando:1:abc123')
  })

  it('a primeira pergunta volta a NULO — nunca inventa uma tentativa que não houve', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    await devolverAReserva({
      prisma: { devSession: { updateMany } } as never,
      sessionName: 'sessions/1',
      hashDaPergunta: 'abc123',
      tentativa: 1,
      marcaAnterior: null,
      agora: new Date('2026-08-26T22:00:00Z'),
    })
    const [arg] = updateMany.mock.calls[0] as unknown as [{ data: { answeredHash: string | null } }]
    expect(arg.data.answeredHash).toBeNull()
  })

  it('perdeu a corrida (ninguém atualizado): devolve false e não insiste', async () => {
    const devolveu = await devolverAReserva({
      prisma: { devSession: { updateMany: vi.fn(async () => ({ count: 0 })) } } as never,
      sessionName: 'sessions/1',
      hashDaPergunta: 'abc123',
      tentativa: 2,
      marcaAnterior: 'tentando:1:abc123',
      agora: new Date('2026-08-26T22:00:00Z'),
    })
    expect(devolveu).toBe(false)
  })

  it('reservar e devolver se cancelam: a pergunta fica exatamente como estava', async () => {
    // A regressão do dono (#246): três quedas de cota consumiram as três
    // tentativas e a pergunta virou `desisti` para sempre. Com a devolução, o
    // estado depois de uma falha de motor é IDÊNTICO ao de antes.
    let marca: string | null = 'tentando:1:abc123'
    const prisma = {
      devSession: {
        updateMany: vi.fn(
          async (args: {
            where: { answeredHash: string | null }
            data: { answeredHash: string | null }
          }) => {
            if (args.where.answeredHash !== marca) return { count: 0 }
            marca = args.data.answeredHash
            return { count: 1 }
          }
        ),
      },
    } as never
    const antes = marca
    await reservarAResposta({
      prisma,
      sessionName: 'sessions/1',
      hashDaPergunta: 'abc123',
      tentativa: 2,
      marcaLida: antes,
      agora: new Date(),
    })
    expect(marca).toBe('tentando:2:abc123')
    await devolverAReserva({
      prisma,
      sessionName: 'sessions/1',
      hashDaPergunta: 'abc123',
      tentativa: 2,
      marcaAnterior: antes,
      agora: new Date(),
    })
    expect(marca).toBe(antes)
  })
})
