import { describe, it, expect, vi } from 'vitest'
import { pegarATrava, VALIDADE_DA_TRAVA_MS, type PrismaParaTrava } from './trava-de-renovacao.js'

const AGORA = new Date('2026-08-26T20:00:00Z')

/** Um banco de mentira que respeita a condição do `where`, como o de verdade. */
function bancoFalso(travadaAte: Date | null) {
  let trava = travadaAte
  const prisma: PrismaParaTrava = {
    engineConnection: {
      updateMany: vi.fn(async ({ where, data }) => {
        const livre = trava === null || trava.getTime() < AGORA.getTime()
        const condiz = (where.OR as Array<Record<string, unknown>>).length === 2
        if (!livre || !condiz) return { count: 0 }
        trava = data.renewalLockedUntil
        return { count: 1 }
      }),
    },
  }
  return {
    prisma,
    get trava() {
      return trava
    },
  }
}

const COMUM = { userId: 'u1', runtime: 'codex', agora: AGORA }

describe('pegarATrava — uma renovação por vez', () => {
  it('trava livre: passa', async () => {
    const b = bancoFalso(null)
    expect(await pegarATrava({ ...COMUM, prisma: b.prisma })).toBe(true)
  })

  it('DOIS caminhos ao mesmo tempo: só um passa', async () => {
    // É o caso real: a vigília de hora em hora e a captura depois da missão
    // caindo na mesma janela. A segunda usaria um token já queimado, e a conta
    // do cliente cairia por culpa nossa.
    const b = bancoFalso(null)
    const [um, dois] = await Promise.all([
      pegarATrava({ ...COMUM, prisma: b.prisma }),
      pegarATrava({ ...COMUM, prisma: b.prisma }),
    ])
    expect([um, dois].filter(Boolean)).toHaveLength(1)
  })

  it('trava de outro, ainda válida: NÃO passa — e isso não é erro', async () => {
    const b = bancoFalso(new Date(AGORA.getTime() + 60_000))
    expect(await pegarATrava({ ...COMUM, prisma: b.prisma })).toBe(false)
  })

  it('trava VENCIDA é tomada — processo que morreu não segura a conta para sempre', async () => {
    const b = bancoFalso(new Date(AGORA.getTime() - 1))
    expect(await pegarATrava({ ...COMUM, prisma: b.prisma })).toBe(true)
  })

  it('a trava tomada tem prazo — nunca é eterna', async () => {
    const b = bancoFalso(null)
    await pegarATrava({ ...COMUM, prisma: b.prisma })
    expect(b.trava?.getTime()).toBe(AGORA.getTime() + VALIDADE_DA_TRAVA_MS)
  })

  it('a condição de "livre ou vencida" vai no where, não é decidida em memória', async () => {
    // Decidir em memória traria de volta a corrida: ler, achar livre, e dois
    // gravarem. A condição tem que viajar até o banco.
    const b = bancoFalso(null)
    await pegarATrava({ ...COMUM, prisma: b.prisma })
    const chamada = (b.prisma.engineConnection.updateMany as ReturnType<typeof vi.fn>).mock
      .calls[0]![0]
    expect(chamada.where.OR).toHaveLength(2)
    expect(chamada.where.userId).toBe('u1')
    expect(chamada.where.runtime).toBe('codex')
  })
})
