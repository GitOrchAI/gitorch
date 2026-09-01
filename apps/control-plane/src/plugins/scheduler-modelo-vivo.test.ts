import { describe, expect, test, vi } from 'vitest'
import { modeloVivoParaAMissao } from './scheduler.js'

// A LISTA REAL do catálogo, no formato EXATO em que o banco a guarda hoje:
// `slug<TAB>Nome de Exibição`. Conferido em 01/09/2026 com
// `select models from engine_connections where runtime='antigravity'` — 14
// entradas, todas coladas. A coleta nova (model-catalog.ts) já grava separado,
// mas as linhas antigas seguem no banco até a migração rodar, e a guarda tem
// que funcionar com as DUAS formas.
const CATALOGO_DO_BANCO_COLADO = [
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
]

const prismaCom = (
  models: unknown
): { engineConnection: { findFirst: () => Promise<unknown> } } => ({
  engineConnection: { findFirst: vi.fn().mockResolvedValue(models === null ? null : { models }) },
})

const semLog = { warn: (): void => undefined }

describe('modeloVivoParaAMissao — o modelo sai do catálogo, não de um literal que envelhece', () => {
  test('o modelo morto de 31/08 é trocado pelo vivo mais novo da mesma família', async () => {
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(CATALOGO_DO_BANCO_COLADO),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.5 Flash (Medium)',
      log: semLog,
    })
    expect(r).toBe('Gemini 3.7 Flash (Medium)')
  })

  test('modelo vivo passa intacto — a guarda não mexe no que funciona', async () => {
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(CATALOGO_DO_BANCO_COLADO),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.1 Pro (Low)',
      log: semLog,
    })
    expect(r).toBe('Gemini 3.1 Pro (Low)')
  })

  test('FAIL-OPEN: sem conexão no banco, segue com o modelo pedido', async () => {
    // Catálogo ausente quer dizer "não sei", NUNCA "o modelo não existe". Uma
    // guarda que desligasse o motor por não ter lista trocaria um desperdício
    // por uma paralisação da esteira inteira.
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(null),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.5 Flash (Medium)',
      log: semLog,
    })
    expect(r).toBe('Gemini 3.5 Flash (Medium)')
  })

  test('FAIL-OPEN: banco fora do ar não derruba a missão', async () => {
    const prisma = {
      engineConnection: { findFirst: vi.fn().mockRejectedValue(new Error('sem conexão')) },
    }
    const r = await modeloVivoParaAMissao({
      prisma,
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.5 Flash (Medium)',
      log: semLog,
    })
    expect(r).toBe('Gemini 3.5 Flash (Medium)')
  })

  test('catálogo de forma inesperada (não é lista de texto) não quebra nem inventa', async () => {
    for (const lixo of [{ nao: 'é lista' }, [1, 2, 3], 'texto solto', []]) {
      const r = await modeloVivoParaAMissao({
        prisma: prismaCom(lixo),
        ownerUserId: 'user_1',
        runtime: 'antigravity',
        desejado: 'Gemini 3.5 Flash (Medium)',
        log: semLog,
      })
      expect(r).toBe('Gemini 3.5 Flash (Medium)')
    }
  })

  test('sem dono (projeto legado com userId nulo) não consulta banco nenhum', async () => {
    const prisma = prismaCom(CATALOGO_DO_BANCO_COLADO)
    const r = await modeloVivoParaAMissao({
      prisma,
      ownerUserId: null,
      runtime: 'antigravity',
      desejado: 'Gemini 3.5 Flash (Medium)',
      log: semLog,
    })
    expect(r).toBe('Gemini 3.5 Flash (Medium)')
    expect(prisma.engineConnection.findFirst).not.toHaveBeenCalled()
  })

  test('FAIL-OPEN de verdade: prisma sem engineConnection não derruba a missão', async () => {
    // Regressão real pega pela suíte: `.catch()` só pega promessa rejeitada, e
    // aqui o tropeço é SÍNCRONO (ler .findFirst de undefined). O contrato desta
    // função é fail-open em TODO caminho de dúvida — inclusive neste.
    for (const prisma of [{}, { engineConnection: {} }, undefined]) {
      const r = await modeloVivoParaAMissao({
        prisma: prisma as never,
        ownerUserId: 'user_1',
        runtime: 'antigravity',
        desejado: 'Gemini 3.5 Flash (Medium)',
        log: semLog,
      })
      expect(r).toBe('Gemini 3.5 Flash (Medium)')
    }
  })

  test('quando troca, DIZ — silêncio aqui é como o defeito durou 9h48', async () => {
    const avisos: string[] = []
    await modeloVivoParaAMissao({
      prisma: prismaCom(CATALOGO_DO_BANCO_COLADO),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.5 Flash (Medium)',
      log: { warn: (m: string) => avisos.push(m) },
    })
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('Gemini 3.5 Flash (Medium)')
    expect(avisos[0]).toContain('Gemini 3.7 Flash (Medium)')
  })

  test('modelo sem equivalente: mantém o pedido e avisa, mas não inventa outra família', async () => {
    const avisos: string[] = []
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(CATALOGO_DO_BANCO_COLADO),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Modelo Que Nao Existe',
      log: { warn: (m: string) => avisos.push(m) },
    })
    expect(r).toBe('Modelo Que Nao Existe')
    expect(avisos).toHaveLength(1)
  })
})
