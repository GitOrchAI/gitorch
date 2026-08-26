import { describe, it, expect, vi } from 'vitest'
import { reservarAResposta, type PrismaParaReserva } from './reservar-a-resposta.js'
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
