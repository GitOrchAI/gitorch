import { describe, it, expect, vi } from 'vitest'
import {
  registrarEntendimentoDoPedido,
  type RegistrarEntendimentoDeps,
} from './entendimento-do-pedido.js'
import {
  ehGavetaDeEntendimento,
  SALA_DO_ENTENDIMENTO,
  type MissionMemory,
} from './mission-context.js'
import type { EntendimentoDoItem } from './ficha-do-item.js'

const ENTENDIMENTO: EntendimentoDoItem = {
  deOndeVeio: 'Jules pelo GitOrch',
  oQueMuda: 'ajusta o cache de sessão',
  queAjusteE: 'correção',
  porQueExiste: 'sessão expirava cedo demais',
}

type Gaveta = Parameters<MissionMemory['writeDrawer']>[0]

/** Memória em RAM que guarda as gavetas por id, como o Cortex (upsert). */
function memoriaFalsa() {
  const gavetas = new Map<string, Gaveta>()
  const writeDrawer = vi.fn(async (g: Gaveta) => {
    gavetas.set(g.id, g)
  })
  const cortex: MissionMemory & { getDrawerById: (id: string) => { content: string } | null } = {
    recallLocal: () => [],
    writeDrawer,
    getDrawerById: (id) => gavetas.get(id) ?? null,
  }
  return { cortex, gavetas, writeDrawer }
}

function montar(sobrescrever: Partial<RegistrarEntendimentoDeps> = {}) {
  const { cortex, gavetas, writeDrawer } = memoriaFalsa()
  const atualizarFicha = vi.fn(async (_args: unknown) => undefined)
  const lerFicha = vi.fn(
    async (_numero: number) => null as { entendimento: EntendimentoDoItem | null } | null
  )
  const deps: RegistrarEntendimentoDeps = {
    lerFicha,
    atualizarFicha,
    cortex,
    now: () => '2026-09-15T00:00:00.000Z',
    ...sobrescrever,
  }
  const registrar = (args: { headSha?: string; entendimento?: EntendimentoDoItem } = {}) =>
    registrarEntendimentoDoPedido({
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: args.headSha ?? 'aaa111',
      entendimento: args.entendimento ?? ENTENDIMENTO,
      deps,
    })
  return { registrar, atualizarFicha, lerFicha, gavetas, writeDrawer, deps }
}

describe('registrarEntendimentoDoPedido', () => {
  it('grava o entendimento na ficha do PR SEM mexer no retrato (nada de `estado`)', async () => {
    const m = montar()

    await m.registrar()

    expect(m.atualizarFicha).toHaveBeenCalledTimes(1)
    const args = m.atualizarFicha.mock.calls[0]![0] as Record<string, unknown>
    expect(args).toEqual({
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      entendimento: ENTENDIMENTO,
    })
    expect(args).not.toHaveProperty('estado')
  })

  it('a gaveta vai para a sala PRÓPRIA do entendimento, nunca para a sala `qa` que o PO lê como lacuna', async () => {
    const m = montar()

    await m.registrar()

    expect(m.writeDrawer).toHaveBeenCalledTimes(1)
    const gaveta = [...m.gavetas.values()][0]!
    expect(gaveta.roomId).toBe(SALA_DO_ENTENDIMENTO)
    expect(gaveta.roomId).not.toBe('qa')
    expect(gaveta.wingId).toBe('proj-1')
    expect(gaveta.tags).toContain('entendimento')
    expect(ehGavetaDeEntendimento(gaveta.content)).toBe(true)
    expect(gaveta.content).toContain('#42')
    expect(gaveta.content).toContain('ajusta o cache de sessão')
  })

  it('é idempotente: o mesmo entendimento no mesmo commit não regrava nada', async () => {
    const m = montar()
    await m.registrar()
    // Daqui em diante a ficha já tem o entendimento.
    m.lerFicha.mockResolvedValue({ entendimento: ENTENDIMENTO })

    await m.registrar()
    await m.registrar()

    expect(m.atualizarFicha).toHaveBeenCalledTimes(1)
    expect(m.writeDrawer).toHaveBeenCalledTimes(1)
  })

  it('commit novo com o MESMO entendimento: nova gaveta (o head mudou), ficha intacta', async () => {
    const m = montar()
    await m.registrar({ headSha: 'aaa111' })
    m.lerFicha.mockResolvedValue({ entendimento: ENTENDIMENTO })

    await m.registrar({ headSha: 'bbb222' })

    expect(m.atualizarFicha).toHaveBeenCalledTimes(1)
    expect(m.writeDrawer).toHaveBeenCalledTimes(2)
    expect(m.gavetas.size).toBe(2)
  })

  it('entendimento DIFERENTE no mesmo commit: regrava a ficha e a gaveta (mesma gaveta, conteúdo novo)', async () => {
    const m = montar()
    await m.registrar()
    m.lerFicha.mockResolvedValue({ entendimento: ENTENDIMENTO })

    await m.registrar({ entendimento: { ...ENTENDIMENTO, oQueMuda: 'troca o cache por redis' } })

    expect(m.atualizarFicha).toHaveBeenCalledTimes(2)
    expect(m.writeDrawer).toHaveBeenCalledTimes(2)
    expect(m.gavetas.size).toBe(1)
    expect([...m.gavetas.values()][0]!.content).toContain('troca o cache por redis')
  })

  it('a gaveta que faltou (falha anterior no Cortex) é refeita mesmo com a ficha em dia', async () => {
    const m = montar({ lerFicha: vi.fn(async () => ({ entendimento: ENTENDIMENTO })) })

    await m.registrar()

    expect(m.atualizarFicha).not.toHaveBeenCalled()
    expect(m.writeDrawer).toHaveBeenCalledTimes(1)
  })

  it('entendimento incompleto não é gravado (uma ficha com entendimento pela metade liberaria o merge)', async () => {
    const m = montar()

    await m.registrar({ entendimento: { ...ENTENDIMENTO, porQueExiste: '   ' } })

    expect(m.atualizarFicha).not.toHaveBeenCalled()
    expect(m.writeDrawer).not.toHaveBeenCalled()
  })

  it('a ficha é gravada antes da gaveta: falha no Cortex não impede a ficha, e sobe para quem chamou', async () => {
    const { cortex } = memoriaFalsa()
    const m = montar({
      cortex: {
        ...cortex,
        writeDrawer: vi.fn(async () => {
          throw new Error('cortex fora do ar')
        }),
      },
    })

    await expect(m.registrar()).rejects.toThrow('cortex fora do ar')
    expect(m.atualizarFicha).toHaveBeenCalledTimes(1)
  })

  it('sem getDrawerById na memória, a gaveta é regravada pelo id (upsert) e nada duplica', async () => {
    const { gavetas, writeDrawer } = memoriaFalsa()
    const m = montar({
      cortex: {
        recallLocal: () => [],
        writeDrawer: async (g) => {
          gavetas.set(g.id, g)
          await writeDrawer(g)
        },
      },
    })

    await m.registrar()
    await m.registrar()

    expect(gavetas.size).toBe(1)
  })
})
