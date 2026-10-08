import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexClient } from '@gitorch/cortex'
import { registrarDirecaoDoProjeto } from './direcao-do-projeto.js'
import {
  buildMissionEnricher,
  ehGavetaDeDirecao,
  persistMissionMemory,
  PREFIXO_DA_GAVETA_DE_DIRECAO,
  SALA_DA_DIRECAO,
  type MissionMemory,
} from './mission-context.js'
import type { OrigemDoItem } from './origem-do-item.js'

const ENTENDIMENTO = {
  deOndeVeio: 'Outra pessoa',
  oQueMuda: 'novo endpoint de exportação',
  queAjusteE: 'funcionalidade nova',
  porQueExiste: 'cliente pediu exportar relatório em CSV',
}

/** O Cortex em memória: guarda por id, como o real (regravar o id substitui). */
function cortexEmMemoria() {
  const gavetas = new Map<string, Parameters<MissionMemory['writeDrawer']>[0]>()
  const writeDrawer = vi.fn(async (g: Parameters<MissionMemory['writeDrawer']>[0]) => {
    gavetas.set(g.id, g)
  })
  const cortex: MissionMemory = {
    recallLocal: (wing, sala) =>
      [...gavetas.values()].filter((g) => g.wingId === wing && (!sala || g.roomId === sala)),
    getDrawerById: (id) => gavetas.get(id) ?? null,
    writeDrawer,
  }
  return { cortex, gavetas, writeDrawer }
}

function registrar(
  cortex: MissionMemory,
  extra: Partial<Parameters<typeof registrarDirecaoDoProjeto>[0]> = {}
) {
  return registrarDirecaoDoProjeto({
    projectId: 'proj-1',
    numeroDoPr: 590,
    origem: 'pessoa',
    entendimento: ENTENDIMENTO,
    runtimeConfig: null,
    deps: { cortex, now: () => '2026-10-09T00:00:00.000Z' },
    ...extra,
  })
}

describe('registrarDirecaoDoProjeto', () => {
  it('grava UMA gaveta por PR, com id determinístico, em sala e marcação próprias', async () => {
    const { cortex, gavetas } = cortexEmMemoria()

    await registrar(cortex)

    expect([...gavetas.values()]).toEqual([
      expect.objectContaining({
        id: 'direcao:proj-1:590',
        wingId: 'proj-1',
        roomId: SALA_DA_DIRECAO,
        hallId: 'direcao',
      }),
    ])
    const gaveta = gavetas.get('direcao:proj-1:590')!
    expect(gaveta.content.startsWith(PREFIXO_DA_GAVETA_DE_DIRECAO)).toBe(true)
    expect(ehGavetaDeDirecao(gaveta.content)).toBe(true)
    expect(gaveta.content).toContain('origem: pessoa')
    expect(gaveta.content).toContain('#590')
    expect(gaveta.content).toContain('cliente pediu exportar relatório em CSV')
    expect(gaveta.content).toContain('novo endpoint de exportação')
  })

  it('nunca grava nas salas `ra`, `po` ou `qa`: a do RA é o contrato do PO, a do QA é lacuna de backlog', async () => {
    const { cortex, gavetas } = cortexEmMemoria()

    await registrar(cortex)

    const salas = [...gavetas.values()].map((g) => g.roomId)
    expect(salas).not.toContain('ra')
    expect(salas).not.toContain('po')
    expect(salas).not.toContain('qa')
  })

  it('texto de PR com emoji na fronteira dos 400 caracteres vai ao Cortex sem substituto solto', async () => {
    const emoji = '\u{1F600}'
    const { cortex, gavetas } = cortexEmMemoria()

    await registrar(cortex, {
      entendimento: {
        ...ENTENDIMENTO,
        porQueExiste: `${'p'.repeat(398)}${emoji}${'q'.repeat(50)}`,
        oQueMuda: 'muda\uD83D',
      },
    })

    const content = gavetas.get('direcao:proj-1:590')!.content
    expect(content).toContain(`${'p'.repeat(398)}${emoji}…`)
    expect(content).toContain('muda\uFFFD')
    expect(content).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    )
  })

  it('regravar o mesmo julgamento não duplica nem regrava', async () => {
    const { cortex, gavetas, writeDrawer } = cortexEmMemoria()

    await registrar(cortex)
    await registrar(cortex)
    await registrar(cortex)

    expect(gavetas.size).toBe(1)
    expect(writeDrawer).toHaveBeenCalledTimes(1)
  })

  it('entendimento novo do mesmo PR atualiza a MESMA gaveta, sem somar outra', async () => {
    const { cortex, gavetas, writeDrawer } = cortexEmMemoria()

    await registrar(cortex)
    await registrar(cortex, {
      entendimento: { ...ENTENDIMENTO, porQueExiste: 'o cliente mudou o formato para XLSX' },
    })

    expect(gavetas.size).toBe(1)
    expect(writeDrawer).toHaveBeenCalledTimes(2)
    expect(gavetas.get('direcao:proj-1:590')!.content).toContain('XLSX')
    expect(gavetas.get('direcao:proj-1:590')!.content).not.toContain('CSV')
  })

  it('PRs e projetos diferentes ficam em gavetas diferentes', async () => {
    const { cortex, gavetas } = cortexEmMemoria()

    await registrar(cortex)
    await registrar(cortex, { numeroDoPr: 591 })
    await registrar(cortex, { projectId: 'proj-2' })

    expect([...gavetas.keys()].sort()).toEqual([
      'direcao:proj-1:590',
      'direcao:proj-1:591',
      'direcao:proj-2:590',
    ])
  })

  describe('origem', () => {
    for (const origem of ['assistente', 'pessoa', 'jules_fora'] as const) {
      it(`origem ${origem} (lida da ficha) grava`, async () => {
        const { cortex, gavetas } = cortexEmMemoria()
        await registrar(cortex, { origem })
        expect(gavetas.size).toBe(1)
        expect(gavetas.get('direcao:proj-1:590')!.content).toContain(`origem: ${origem}`)
      })
    }

    for (const origem of ['jules_gitorch', 'dependabot', 'outro_bot', null] as const) {
      it(`origem ${String(origem)} NÃO grava: não é direção de fora do GitOrch`, async () => {
        const { cortex, writeDrawer } = cortexEmMemoria()
        await registrar(cortex, { origem: origem as OrigemDoItem | null })
        expect(writeDrawer).not.toHaveBeenCalled()
      })
    }
  })

  describe('política de cuidado por origem', () => {
    it('sem configuração, o padrão ("perguntar" para assistente e pessoa) ainda aprende', async () => {
      const { cortex, gavetas } = cortexEmMemoria()
      await registrar(cortex, { origem: 'assistente', runtimeConfig: {} })
      await registrar(cortex, { origem: 'pessoa', numeroDoPr: 591, runtimeConfig: undefined })
      expect(gavetas.size).toBe(2)
    })

    it('"sim" e "perguntar" aprendem', async () => {
      const { cortex, gavetas } = cortexEmMemoria()
      await registrar(cortex, {
        runtimeConfig: { cuidaPorOrigem: { pessoa: 'sim' } },
      })
      await registrar(cortex, {
        numeroDoPr: 591,
        runtimeConfig: { cuidaPorOrigem: { pessoa: 'perguntar' } },
      })
      expect(gavetas.size).toBe(2)
    })

    for (const origem of ['pessoa', 'assistente'] as const) {
      it(`origem ${origem} com política "nao" é ignorada`, async () => {
        const { cortex, writeDrawer } = cortexEmMemoria()
        await registrar(cortex, {
          origem,
          runtimeConfig: { cuidaPorOrigem: { [origem]: 'nao' } },
        })
        expect(writeDrawer).not.toHaveBeenCalled()
      })
    }

    it('jules_fora responde pela política do balde `jules`', async () => {
      const { cortex, writeDrawer } = cortexEmMemoria()
      await registrar(cortex, {
        origem: 'jules_fora',
        runtimeConfig: { cuidaPorOrigem: { jules: 'nao' } },
      })
      expect(writeDrawer).not.toHaveBeenCalled()
    })

    it('"nao" de OUTRA origem não atrapalha', async () => {
      const { cortex, gavetas } = cortexEmMemoria()
      await registrar(cortex, {
        origem: 'pessoa',
        runtimeConfig: { cuidaPorOrigem: { assistente: 'nao', jules: 'nao' } },
      })
      expect(gavetas.size).toBe(1)
    })
  })

  describe('entendimento incompleto não grava', () => {
    for (const campo of ['deOndeVeio', 'oQueMuda', 'queAjusteE', 'porQueExiste'] as const) {
      it(`campo ${campo} vazio`, async () => {
        const { cortex, writeDrawer } = cortexEmMemoria()
        await registrar(cortex, { entendimento: { ...ENTENDIMENTO, [campo]: '   ' } })
        expect(writeDrawer).not.toHaveBeenCalled()
      })
    }

    it('campo ausente (o veredito veio sem o campo)', async () => {
      const { cortex, writeDrawer } = cortexEmMemoria()
      const { oQueMuda: _fora, ...semUmCampo } = ENTENDIMENTO
      await registrar(cortex, {
        entendimento: semUmCampo as unknown as typeof ENTENDIMENTO,
      })
      expect(writeDrawer).not.toHaveBeenCalled()
    })
  })

  it('o texto vira uma linha só e tem teto: uma descrição enorme não incha a memória', async () => {
    const { cortex, gavetas } = cortexEmMemoria()

    await registrar(cortex, {
      entendimento: {
        ...ENTENDIMENTO,
        porQueExiste: `primeira linha\n\n${'x'.repeat(5000)}`,
      },
    })

    const { content } = gavetas.get('direcao:proj-1:590')!
    expect(content).not.toContain('\n')
    expect(content.length).toBeLessThan(1500)
  })
})

// Com o Cortex de verdade (SQLite em arquivo temporário) e o enriquecedor que
// monta o contexto das missões. O que está em jogo é o que o PO e o analista
// leem DEPOIS da gravação: o contrato do RA continua sendo o contrato, a
// direção chega num bloco próprio e nunca vira lacuna de backlog.
describe('direção do projeto lida pelo enriquecedor (Cortex real)', () => {
  const PROJETO = 'proj-direcao'
  const CONTRATO = '### Journey 0: comprador\n1. abre a loja\n### Journey 1: vendedor\n1. cadastra'
  const LACUNA = 'QA gap: o repositório não tem verificação automática'

  function comCortex(teste: (cortex: CortexClient) => Promise<void>) {
    return async () => {
      const pasta = mkdtempSync(join(tmpdir(), 'gitorch-direcao-'))
      const cortex = new CortexClient({ sqlitePath: join(pasta, 'cortex.sqlite') })
      cortex.init()
      try {
        await teste(cortex)
      } finally {
        cortex.close()
        rmSync(pasta, { recursive: true, force: true })
      }
    }
  }

  async function memoriaBase(cortex: CortexClient) {
    await persistMissionMemory(cortex, {
      projectId: PROJETO,
      role: 'ra',
      content: CONTRATO,
      now: '2026-10-05T10:00:00.000Z',
    })
    await persistMissionMemory(cortex, {
      projectId: PROJETO,
      role: 'qa',
      content: LACUNA,
      now: '2026-10-06T10:00:00.000Z',
    })
  }

  const gravarDirecao = (cortex: CortexClient, extra: { now?: string; numeroDoPr?: number } = {}) =>
    registrarDirecaoDoProjeto({
      projectId: PROJETO,
      numeroDoPr: extra.numeroDoPr ?? 590,
      origem: 'assistente',
      entendimento: ENTENDIMENTO,
      runtimeConfig: null,
      deps: { cortex, now: () => extra.now ?? '2026-10-09T10:00:00.000Z' },
    })

  it(
    'o contexto do PO continua COMEÇANDO pelo contrato do RA, mesmo com a direção gravada depois dele',
    comCortex(async (cortex) => {
      await memoriaBase(cortex)
      await gravarDirecao(cortex)

      const linhas = await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'po' })

      expect(linhas[0]).toBe(CONTRATO)
    })
  )

  it(
    'a direção aparece num bloco próprio para o PO e para o analista (RA)',
    comCortex(async (cortex) => {
      await memoriaBase(cortex)
      await gravarDirecao(cortex)

      for (const role of ['po', 'ra'] as const) {
        const linhas = await buildMissionEnricher({ cortex })({ projectId: PROJETO, role })
        const blocos = linhas.filter((l) => l.includes(PREFIXO_DA_GAVETA_DE_DIRECAO))
        expect(blocos, role).toHaveLength(1)
        expect(blocos[0]).toContain('cliente pediu exportar relatório em CSV')
        // Bloco dela, e não dentro do contrato nem da memória de lacunas.
        expect(blocos[0]).not.toContain('Journey 0')
        expect(blocos[0]).not.toContain(LACUNA)
        expect(blocos[0]).toMatch(/not the contract|NOT the contract/i)
      }
    })
  )

  it(
    'a direção não vira lacuna de backlog nem entra na memória geral do projeto',
    comCortex(async (cortex) => {
      await memoriaBase(cortex)
      await gravarDirecao(cortex)

      const linhas = await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'po' })
      const memoria = linhas.find((l) => l.startsWith('Project memory'))!

      expect(memoria).toContain(LACUNA)
      expect(memoria).not.toContain(PREFIXO_DA_GAVETA_DE_DIRECAO)
      expect(memoria).not.toContain('exportar relatório')
    })
  )

  it(
    'quem não lê direção (QA e SM) recebe exatamente o que recebia antes',
    comCortex(async (cortex) => {
      await memoriaBase(cortex)
      const antes = {
        qa: await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'qa' }),
        sm: await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'sm' }),
      }

      await gravarDirecao(cortex)

      expect(await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'qa' })).toEqual(
        antes.qa
      )
      expect(await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'sm' })).toEqual(
        antes.sm
      )
    })
  )

  it(
    'rejulgar o mesmo PR não duplica a direção no contexto; PR novo soma outra',
    comCortex(async (cortex) => {
      await memoriaBase(cortex)
      await gravarDirecao(cortex, { now: '2026-10-09T10:00:00.000Z' })
      await gravarDirecao(cortex, { now: '2026-10-10T10:00:00.000Z' })
      await gravarDirecao(cortex, { now: '2026-10-11T10:00:00.000Z' })

      expect(cortex.recallLocal(PROJETO, SALA_DA_DIRECAO)).toHaveLength(1)
      const um = await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'po' })
      expect(um.join('\n').split('exportar relatório').length - 1).toBe(1)

      await gravarDirecao(cortex, { numeroDoPr: 591 })
      expect(cortex.recallLocal(PROJETO, SALA_DA_DIRECAO)).toHaveLength(2)
    })
  )

  it(
    'por defesa, uma direção que cair na sala `ra` não toma o lugar do contrato do PO',
    comCortex(async (cortex) => {
      await memoriaBase(cortex)
      // Como a versão antiga gravava: sala `ra`, mais nova que o contrato.
      await persistMissionMemory(cortex, {
        projectId: PROJETO,
        role: 'ra',
        content: `${PREFIXO_DA_GAVETA_DE_DIRECAO} (origem: pessoa): cliente pediu CSV. Mudança: exportação.`,
        now: '2026-10-09T10:00:00.000Z',
      })

      const linhas = await buildMissionEnricher({ cortex })({ projectId: PROJETO, role: 'po' })

      expect(linhas[0]).toBe(CONTRATO)
    })
  )
})
