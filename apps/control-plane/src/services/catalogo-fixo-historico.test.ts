import { describe, expect, test, vi } from 'vitest'
import {
  CATALOGO_FIXO_HISTORICO_CLAUDE,
  ehCatalogoFixoHistorico,
  reclassificarCatalogoFixoNoBoot,
  MOTIVO_CATALOGO_FIXO_HISTORICO,
} from './catalogo-fixo-historico.js'

describe('ehCatalogoFixoHistorico', () => {
  test('bate a lista fixa histórica na ordem original', () => {
    expect(ehCatalogoFixoHistorico([...CATALOGO_FIXO_HISTORICO_CLAUDE])).toBe(true)
  })

  test('bate a lista fixa histórica em QUALQUER ordem — o coletor antigo nunca garantiu ordem', () => {
    expect(ehCatalogoFixoHistorico([...CATALOGO_FIXO_HISTORICO_CLAUDE].reverse())).toBe(true)
    expect(
      ehCatalogoFixoHistorico([
        'claude-sonnet-5',
        'claude-fable-5',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-8',
      ])
    ).toBe(true)
  })

  test('catálogo real diferente NÃO bate — nem com sobra, nem com falta', () => {
    expect(ehCatalogoFixoHistorico(['Claude Opus 5', 'Claude Sonnet 5'])).toBe(false)
    expect(ehCatalogoFixoHistorico([...CATALOGO_FIXO_HISTORICO_CLAUDE, 'claude-extra'])).toBe(false)
    expect(ehCatalogoFixoHistorico(CATALOGO_FIXO_HISTORICO_CLAUDE.slice(0, 3))).toBe(false)
  })

  test('catálogo vazio NÃO bate — não é a lista fixa, é ausência de leitura', () => {
    expect(ehCatalogoFixoHistorico([])).toBe(false)
  })

  test('valores não-string na lista nunca casam (blindagem de tipo, dado vindo de JSON solto)', () => {
    expect(ehCatalogoFixoHistorico([1, 2, 3, 4])).toBe(false)
  })
})

function fakePrisma(linhas: Array<{ id: string; runtime: string; models: unknown }>) {
  const store = new Map(linhas.map((l) => [l.id, { ...l }]))
  return {
    store,
    engineConnection: {
      findMany: vi.fn(async ({ where }: { where: { runtime: string } }) =>
        [...store.values()]
          .filter((l) => l.runtime === where.runtime)
          .map((l) => ({ id: l.id, models: l.models }))
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: { in: string[] } }
          data: Record<string, unknown>
        }) => {
          let count = 0
          for (const id of where.id.in) {
            const existing = store.get(id)
            if (!existing) continue
            store.set(id, { ...existing, ...data })
            count++
          }
          return { count }
        }
      ),
    },
  }
}

function fakeLog() {
  const avisos: Array<{ obj: unknown; msg: string | undefined }> = []
  return { avisos, log: { warn: (obj: unknown, msg?: string) => avisos.push({ obj, msg }) } }
}

describe('reclassificarCatalogoFixoNoBoot', () => {
  test('conexão claude com o catálogo fixo histórico vira NÃO LIDA: models=[], modelsRefreshedAt=null, motivo em lastError', async () => {
    const prisma = fakePrisma([
      {
        id: 'c1',
        runtime: 'claude',
        models: [...CATALOGO_FIXO_HISTORICO_CLAUDE],
      },
    ])
    const { log, avisos } = fakeLog()

    const quantidade = await reclassificarCatalogoFixoNoBoot(prisma, log)

    expect(quantidade).toBe(1)
    const rec = prisma.store.get('c1') as Record<string, unknown>
    expect(rec['models']).toEqual([])
    expect(rec['modelsRefreshedAt']).toBeNull()
    expect(rec['lastError']).toBe(MOTIVO_CATALOGO_FIXO_HISTORICO)
    expect(avisos).toHaveLength(1)
  })

  test('CATÁLOGO REAL PRESERVADO: conexão claude com catálogo diferente da lista fixa não é tocada', async () => {
    const prisma = fakePrisma([
      {
        id: 'c1',
        runtime: 'claude',
        models: ['Claude Opus 5', 'Claude Sonnet 5', 'Claude Haiku 5'],
      },
    ])
    const { log, avisos } = fakeLog()

    const quantidade = await reclassificarCatalogoFixoNoBoot(prisma, log)

    expect(quantidade).toBe(0)
    const rec = prisma.store.get('c1') as Record<string, unknown>
    expect(rec['models']).toEqual(['Claude Opus 5', 'Claude Sonnet 5', 'Claude Haiku 5'])
    expect(avisos).toHaveLength(0)
  })

  test('conexão claude sem catálogo nenhum (nunca lida) não é tocada', async () => {
    const prisma = fakePrisma([{ id: 'c1', runtime: 'claude', models: null }])
    const quantidade = await reclassificarCatalogoFixoNoBoot(prisma, fakeLog().log)
    expect(quantidade).toBe(0)
  })

  test('IDEMPOTENTE: rodar duas vezes na mesma linha não muda nada na segunda', async () => {
    const prisma = fakePrisma([
      { id: 'c1', runtime: 'claude', models: [...CATALOGO_FIXO_HISTORICO_CLAUDE] },
    ])
    const { log } = fakeLog()

    const primeira = await reclassificarCatalogoFixoNoBoot(prisma, log)
    expect(primeira).toBe(1)
    const depoisDaPrimeira = { ...(prisma.store.get('c1') as Record<string, unknown>) }

    const segunda = await reclassificarCatalogoFixoNoBoot(prisma, log)
    expect(segunda).toBe(0)
    expect(prisma.store.get('c1')).toEqual(depoisDaPrimeira)
  })

  test('só toca runtime claude — outro motor com a mesma lista (hipotético) não é filtrado por esta rotina', async () => {
    const prisma = fakePrisma([
      { id: 'c1', runtime: 'codex', models: [...CATALOGO_FIXO_HISTORICO_CLAUDE] },
    ])
    // findMany já filtra por runtime: 'claude' na query — o fake honra isso,
    // então nenhuma linha 'codex' nunca chega no filtro em memória.
    const quantidade = await reclassificarCatalogoFixoNoBoot(prisma, fakeLog().log)
    expect(quantidade).toBe(0)
  })

  test('nunca lança: erro do prisma vira 0 e um warn, não derruba o boot', async () => {
    const prisma = {
      engineConnection: {
        findMany: vi.fn(async () => {
          throw new Error('conexão com o banco caiu')
        }),
        updateMany: vi.fn(),
      },
    }
    const { log, avisos } = fakeLog()
    const quantidade = await reclassificarCatalogoFixoNoBoot(prisma, log)
    expect(quantidade).toBe(0)
    expect(avisos).toHaveLength(1)
    expect(prisma.engineConnection.updateMany).not.toHaveBeenCalled()
  })
})
