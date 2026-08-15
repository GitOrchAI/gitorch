import { describe, it, expect } from 'vitest'
import {
  buildMissionEnricher,
  persistMissionMemory,
  type MissionMemory,
} from './mission-context.js'

function fakeCortex(
  initial: Array<{ content: string; createdAt?: string }> = [],
  byRoom: Record<string, Array<{ content: string; createdAt?: string }>> = {}
): MissionMemory & {
  written: Array<{ wingId: string; roomId: string; tags: string[]; content: string }>
} {
  const written: Array<{ wingId: string; roomId: string; tags: string[]; content: string }> = []
  return {
    written,
    recallLocal: (_wing, roomId) => (roomId ? (byRoom[roomId] ?? []) : initial),
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

  it('PO recebe o entregável do RA INTACTO (quebras de linha preservadas p/ parse de jornadas)', async () => {
    const ra = 'RA analysis:\n### Journey 0: comprador\n1. abre\n### Journey 1: dados\n1. lê'
    const cortex = fakeCortex([{ content: ra }, { content: 'outra memória' }], {
      ra: [{ content: ra }],
    })
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'po' })

    // bloco intacto (multilinha) + memórias comprimidas SEM duplicar o RA
    expect(lines[0]).toContain('### Journey 1: dados')
    expect(lines[0]).toContain('\n')
    expect(lines[1]).toContain('outra memória')
    expect(lines[1]).not.toContain('### Journey')
  })

  it('com dois entregáveis do RA, o PO recebe o MAIS NOVO (recência desempata)', async () => {
    const cortex = fakeCortex([], {
      ra: [
        { content: '### Journey 0: analise VELHA', createdAt: '2026-07-05T10:00:00Z' },
        { content: '### Journey 0: analise NOVA', createdAt: '2026-07-05T18:00:00Z' },
      ],
    })
    const enrich = buildMissionEnricher({ cortex })
    const lines = await enrich({ projectId: 'p1', role: 'po' })
    expect(lines[0]).toContain('analise NOVA')
    expect(lines[0]).not.toContain('analise VELHA')
  })

  it('RA (e outros papéis) não recebem o bloco intacto — só o PO precisa', async () => {
    const cortex = fakeCortex([{ content: 'm' }], { ra: [{ content: '### Journey 0: x' }] })
    const enrich = buildMissionEnricher({ cortex })
    const lines = await enrich({ projectId: 'p1', role: 'ra' })
    expect(lines.join('\n')).not.toContain('### Journey 0')
  })

  it('o PO recebe a memória do QA junto com a do RA', async () => {
    const cortex = fakeCortex([], {
      ra: [{ content: 'RA: as áreas tocadas são X e Y' }],
      qa: [{ content: 'GITORCH-GAP: this repository has no automated checks' }],
    })
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'po' })
    const texto = lines.join('\n')

    expect(texto).toContain('RA: as áreas tocadas são X e Y')
    expect(texto).toContain('GITORCH-GAP: this repository has no automated checks')
  })

  it('QA (e outros papéis que não o PO) não recebem a memória do QA — só o PO planeja em cima dela', async () => {
    const cortex = fakeCortex([], {
      qa: [{ content: 'GITORCH-GAP: this repository has no automated checks' }],
    })
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'qa' })

    expect(lines.join('\n')).not.toContain('GITORCH-GAP')
  })

  it('mesmo com várias gavetas do QA, o RA continua chegando inteiro ao PO (RA nunca é expulso)', async () => {
    const ra = 'RA analysis:\n### Journey 0: comprador\n1. abre'
    const cortex = fakeCortex([], {
      ra: [{ content: ra }],
      qa: [
        { content: 'GITORCH-GAP: achado 1', createdAt: '2026-08-01T00:00:00Z' },
        { content: 'GITORCH-GAP: achado 2', createdAt: '2026-08-02T00:00:00Z' },
        { content: 'GITORCH-GAP: achado 3', createdAt: '2026-08-03T00:00:00Z' },
      ],
    })
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'po' })
    const texto = lines.join('\n')

    expect(texto).toContain('### Journey 0: comprador')
    expect(texto).toContain('GITORCH-GAP: achado 1')
    expect(texto).toContain('GITORCH-GAP: achado 2')
    expect(texto).toContain('GITORCH-GAP: achado 3')
  })

  it('não duplica uma gaveta do QA que também aparece na lista geral de memórias', async () => {
    const qaGap = { content: 'GITORCH-GAP: this repository has no automated checks' }
    const cortex = fakeCortex([qaGap], { qa: [qaGap] })
    const enrich = buildMissionEnricher({ cortex })

    const lines = await enrich({ projectId: 'p1', role: 'po' })
    const texto = lines.join('\n')
    const ocorrencias = texto.split(qaGap.content).length - 1

    expect(ocorrencias).toBe(1)
  })

  it('injeta o codegraph quando há workspace e o resumo isolado responde', async () => {
    const cortex = fakeCortex([])
    const enrich = buildMissionEnricher({
      cortex,
      summarize: async () => 'codegraph: 12 files, routes /api/x',
    })

    const lines = await enrich({ projectId: 'p1', role: 'po', workspacePath: '/tmp/ws' })

    expect(lines[0]).toContain('codegraph: 12 files')
  })

  it('segue sem codegraph quando o processo isolado falha (crash do WASM não derruba nada)', async () => {
    const cortex = fakeCortex([{ content: 'memória sobrevive' }])
    const enrich = buildMissionEnricher({
      cortex,
      summarize: async () => undefined,
    })

    const lines = await enrich({ projectId: 'p1', role: 'po', workspacePath: '/tmp/ws' })

    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('memória sobrevive')
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
