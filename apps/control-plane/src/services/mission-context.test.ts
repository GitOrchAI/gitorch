import { describe, it, expect } from 'vitest'
import {
  buildMissionEnricher,
  persistMissionMemory,
  type MissionMemory,
} from './mission-context.js'

function fakeCortex(initial: Array<{ content: string }> = []): MissionMemory & {
  written: Array<{ wingId: string; roomId: string; tags: string[]; content: string }>
} {
  const written: Array<{ wingId: string; roomId: string; tags: string[]; content: string }> = []
  return {
    written,
    recallLocal: () => initial,
    writeDrawer: async (d) => {
      written.push({ wingId: d.wingId, roomId: d.roomId, tags: d.tags, content: d.content })
    },
  }
}

describe('buildMissionEnricher', () => {
  it('injeta memórias do projeto como contexto (sem workspace, só memória)', async () => {
    const cortex = fakeCortex([{ content: 'RA brief: projeto é uma API de tarefas.' }])
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'po' })

    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('Project memory')
    expect(lines[0]).toContain('API de tarefas')
  })

  it('não injeta nada quando não há memória nem workspace', async () => {
    const cortex = fakeCortex([])
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'ra' })

    expect(lines).toEqual([])
  })

  it('sobrevive a um Cortex que lança (best-effort)', async () => {
    const cortex: MissionMemory = {
      recallLocal: () => {
        throw new Error('cortex down')
      },
      writeDrawer: async () => {},
    }
    const enrich = buildMissionEnricher({ cortex })

    await expect(enrich({ projectId: 'p1', role: 'ra' })).resolves.toEqual([])
  })
})

describe('persistMissionMemory', () => {
  it('grava o entregável como drawer tipado por projeto e papel', async () => {
    const cortex = fakeCortex()

    await persistMissionMemory(cortex, {
      projectId: 'p1',
      role: 'ra',
      content: 'Research Brief ...',
      now: '2026-07-04T00:00:00Z',
    })

    expect(cortex.written).toHaveLength(1)
    expect(cortex.written[0]).toMatchObject({
      wingId: 'p1',
      roomId: 'ra',
      tags: ['ra', 'deliverable'],
    })
  })

  it('ignora entregável vazio', async () => {
    const cortex = fakeCortex()
    await persistMissionMemory(cortex, { projectId: 'p1', role: 'qa', content: '   ', now: 'now' })
    expect(cortex.written).toHaveLength(0)
  })
})
