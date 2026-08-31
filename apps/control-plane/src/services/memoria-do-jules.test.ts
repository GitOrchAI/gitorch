import { describe, it, expect, vi } from 'vitest'
import {
  registrarAprendizado,
  lerAprendizados,
  guiaCuradoDoJules,
  blocoDeContextoDoJules,
  TIPO_DO_APRENDIZADO,
  type PrismaEventoDoJules,
} from './memoria-do-jules.js'

function fakePrisma(eventos: Array<{ payload: unknown }> = []): {
  prisma: PrismaEventoDoJules
  criados: unknown[]
} {
  const criados: unknown[] = []
  return {
    criados,
    prisma: {
      event: {
        create: vi.fn(async (args: unknown) => {
          criados.push((args as { data: unknown }).data)
        }),
        findMany: vi.fn(async () => eventos),
      },
    },
  }
}

describe('registrarAprendizado', () => {
  it('grava um evento jules-learning com o payload', async () => {
    const { prisma, criados } = fakePrisma()
    await registrarAprendizado({
      prisma,
      projectId: 'p1',
      aprendizado: {
        padrao: 'issues de CI precisam do comando de teste no corpo',
        origem: 'analise-2-falhas',
        issueNumber: 5,
      },
    })
    expect(criados).toHaveLength(1)
    expect(criados[0]).toMatchObject({
      projectId: 'p1',
      type: TIPO_DO_APRENDIZADO,
      payload: { padrao: expect.stringContaining('comando de teste'), issueNumber: 5 },
    })
  })

  it('erro de escrita vira aviso, não exceção', async () => {
    const prisma: PrismaEventoDoJules = {
      event: {
        create: vi.fn(async () => {
          throw new Error('db down')
        }),
        findMany: vi.fn(async () => []),
      },
    }
    const onWarn = vi.fn()
    await expect(
      registrarAprendizado({
        prisma,
        projectId: 'p1',
        aprendizado: { padrao: 'x', origem: 'y' },
        onWarn,
      })
    ).resolves.toBeUndefined()
    expect(onWarn).toHaveBeenCalled()
  })
})

describe('lerAprendizados', () => {
  it('devolve os padrões, dedup por texto', async () => {
    const { prisma } = fakePrisma([
      { payload: { padrao: 'sempre citar o arquivo', origem: 'a' } },
      { payload: { padrao: 'Sempre Citar O Arquivo', origem: 'b' } }, // duplicata (case)
      { payload: { padrao: 'um problema por issue', origem: 'a' } },
    ])
    const r = await lerAprendizados({ prisma, projectId: 'p1' })
    expect(r.map((a) => a.padrao)).toEqual(['sempre citar o arquivo', 'um problema por issue'])
  })

  it('issueNumber traz os da issue primeiro', async () => {
    const { prisma } = fakePrisma([
      { payload: { padrao: 'geral 1', origem: 'a' } },
      { payload: { padrao: 'da issue 7', origem: 'a', issueNumber: 7 } },
      { payload: { padrao: 'geral 2', origem: 'a' } },
    ])
    const r = await lerAprendizados({ prisma, projectId: 'p1', issueNumber: 7 })
    expect(r[0]?.padrao).toBe('da issue 7')
  })

  it('payload torto é ignorado; erro de leitura devolve []', async () => {
    const { prisma } = fakePrisma([{ payload: { origem: 'a' } }, { payload: null }])
    expect(await lerAprendizados({ prisma, projectId: 'p1' })).toEqual([])

    const quebrado: PrismaEventoDoJules = {
      event: {
        create: vi.fn(),
        findMany: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    }
    expect(await lerAprendizados({ prisma: quebrado, projectId: 'p1', onWarn: () => {} })).toEqual(
      []
    )
  })
})

describe('guiaCuradoDoJules', () => {
  it('traz o guia curado com os padrões-chave', () => {
    const g = guiaCuradoDoJules()
    expect(g).toContain('Related Files')
    expect(g).toContain('UMA mudança focada')
    expect(g).toContain('jules-awesome-list')
  })
})

describe('blocoDeContextoDoJules', () => {
  it('junta o guia + os aprendizados num bloco', async () => {
    const { prisma } = fakePrisma([
      { payload: { padrao: 'no gitorch, CI precisa do turbo test', origem: 'a' } },
    ])
    const bloco = await blocoDeContextoDoJules({ prisma, projectId: 'p1' })
    expect(bloco).toContain('Related Files')
    expect(bloco).toContain('turbo test')
    expect(bloco).toContain('LEARNED about how this async dev fails')
  })
})
