import { describe, expect, test, vi } from 'vitest'
import { modeloVivoParaAMissao, degrausQueValemATentativa } from './scheduler.js'

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
    expect(r.modelo).toBe('Gemini 3.7 Flash (Medium)')
  })

  test('modelo vivo passa intacto — a guarda não mexe no que funciona', async () => {
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(CATALOGO_DO_BANCO_COLADO),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.1 Pro (Low)',
      log: semLog,
    })
    expect(r.modelo).toBe('Gemini 3.1 Pro (Low)')
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
    expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
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
    expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
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
      expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
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
    expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
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
      expect(r.modelo).toBe('Gemini 3.5 Flash (Medium)')
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

  test('modelo de OUTRO motor não mata o degrau: roda sem --model e avisa', async () => {
    // PROVADO AO VIVO em 01/09/2026 nesta VM, com a credencial real:
    //   $ claude --model "Gemini 3.7 Flash (Medium)" -p "say ok"
    //   ... There's an issue with the selected model. It may not exist ...
    // E o resolvedor entrega esse nome ao degrau do claude (provado rodando
    // resolveRuntimeChain com os padrões reais: os TRÊS degraus vinham com o
    // modelo do Antigravity). Sem esta saída, o degrau do claude do rodízio é
    // um container queimado toda vez que o failover chega nele.
    const avisos: string[] = []
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(['Claude Opus 5', 'Claude Sonnet 5', 'Claude Haiku 4.5']),
      ownerUserId: 'user_1',
      runtime: 'claude',
      desejado: 'Gemini 3.7 Flash (Medium)',
      log: { warn: (m: string) => avisos.push(m) },
    })
    expect(r.modelo).toBeUndefined()
    expect(r.valeATentativa).toBe(true)
    expect(avisos).toHaveLength(1)
  })

  test('modelo que SAIU do catálogo do próprio motor: o degrau não vale a tentativa', async () => {
    const avisos: string[] = []
    const r = await modeloVivoParaAMissao({
      prisma: prismaCom(CATALOGO_DO_BANCO_COLADO),
      ownerUserId: 'user_1',
      runtime: 'antigravity',
      desejado: 'Gemini 3.5 Flash (Ultra)',
      log: { warn: (m: string) => avisos.push(m) },
    })
    expect(r.valeATentativa).toBe(false)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('antigravity')
    expect(avisos[0]).toContain('Gemini 3.5 Flash (Ultra)')
  })

  test('FAIL-OPEN também no veredito: sem catálogo, todo degrau vale a tentativa', async () => {
    for (const catalogo of [null, [], { nao: 'é lista' }]) {
      const r = await modeloVivoParaAMissao({
        prisma: prismaCom(catalogo),
        ownerUserId: 'user_1',
        runtime: 'antigravity',
        desejado: 'Gemini 3.5 Flash (Ultra)',
        log: semLog,
      })
      expect(r.valeATentativa).toBe(true)
      expect(r.modelo).toBe('Gemini 3.5 Flash (Ultra)')
    }
  })
})

describe('degrausQueValemATentativa — PULA o degrau em vez de queimar a rodada', () => {
  const degrau = (runtime: string, valeATentativa: boolean, modelo?: string) => ({
    runtime,
    valeATentativa,
    ...(modelo !== undefined ? { modelo } : {}),
  })

  test('o degrau com modelo fora do catálogo é PULADO e o seguinte assume', () => {
    // ISTO É O DEFEITO CENTRAL, medido em 31/08: 24 missões em 9h48, cada uma
    // pagando um `podman run` inteiro para receber `invalid model selection`.
    // O motor seguinte da cadeia estava conectado e ocioso ao lado.
    const r = degrausQueValemATentativa([
      degrau('antigravity', false),
      degrau('claude', true, 'Claude Sonnet 5'),
    ])
    expect(r.degraus.map((d) => d.runtime)).toEqual(['claude'])
    expect(r.pulados.map((d) => d.runtime)).toEqual(['antigravity'])
  })

  test('degrau que vale passa intacto — a guarda não mexe no que funciona', () => {
    const cadeia = [degrau('codex', true), degrau('antigravity', true, 'Gemini 3.7 Flash (Medium)')]
    const r = degrausQueValemATentativa(cadeia)
    expect(r.degraus).toEqual(cadeia)
    expect(r.pulados).toEqual([])
  })

  test('NUNCA esvazia a cadeia: se nenhum degrau vale, o ÚLTIMO ainda é tentado', () => {
    // Mesma decisão de `filtrarCadeia` em motor-em-pausa.ts, pela mesma razão
    // escrita lá: ficar sem motor nenhum é trocar desperdício por paralisação.
    // Pular degraus corta 3 containers queimados para 1; pular TODOS pararia a
    // esteira por causa de um catálogo que ninguém conferiu.
    const r = degrausQueValemATentativa([
      degrau('codex', false),
      degrau('antigravity', false),
      degrau('claude', false, 'X'),
    ])
    expect(r.degraus.map((d) => d.runtime)).toEqual(['claude'])
    expect(r.pulados.map((d) => d.runtime)).toEqual(['codex', 'antigravity'])
  })

  test('cadeia vazia continua vazia — não inventa degrau', () => {
    expect(degrausQueValemATentativa([])).toEqual({ degraus: [], pulados: [] })
  })
})
