import { describe, it, expect, vi } from 'vitest'
import {
  adquirirTravaDeParecer,
  assentarTravaDeParecer,
  liberarTravaDeParecer,
  DURACAO_EM_VOO_MS,
  FOLGA_APOS_PUBLICAR_MS,
  type PrismaDaTravaDeParecer,
} from './trava-de-parecer.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function prismaFake(contagem: number) {
  return {
    repoItem: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: contagem })),
    },
  } as unknown as PrismaDaTravaDeParecer
}

describe('adquirirTravaDeParecer', () => {
  it('devolve true quando a atualização condicional bateu em 1 linha', async () => {
    const prisma = prismaFake(1)
    const ok = await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    expect(ok).toBe(true)
  })

  it('devolve false quando 0 linhas bateram (trava já em vigor para este head)', async () => {
    const prisma = prismaFake(0)
    const ok = await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    expect(ok).toBe(false)
  })

  it('a trava tomada vale a janela EM VOO (30 min), maior que o teto de qualquer motor', async () => {
    const prisma = prismaFake(1)
    const agora = new Date('2026-09-15T00:00:00Z')
    await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora,
    })

    const chamada = (prisma.repoItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(DURACAO_EM_VOO_MS).toBe(30 * 60_000)
    expect(chamada.data.parecerTravadoAte).toEqual(new Date('2026-09-15T00:30:00Z'))
  })

  it('a condição do WHERE aceita trava vencida ou head diferente do gravado', async () => {
    const prisma = prismaFake(1)
    await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'novo-sha',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    const chamada = (prisma.repoItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(chamada.where.OR).toEqual([
      { parecerTravadoAte: null },
      { parecerTravadoAte: { lt: new Date('2026-09-15T00:00:00Z') } },
      { parecerTravaHeadSha: { not: 'novo-sha' } },
    ])
  })

  it('garante que a linha existe com upsert antes de tentar a trava', async () => {
    const prisma = prismaFake(1)
    await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    const chamadaUpsert = (prisma.repoItem.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(chamadaUpsert.where).toEqual({
      projectId_tipo_numero: { projectId: 'proj-1', tipo: 'pr', numero: 42 },
    })
    expect(chamadaUpsert.create).toEqual({
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'unknown' },
    })
    expect(chamadaUpsert.update).toEqual({})
  })

  // Duas chamadas simultâneas para uma ficha ainda inexistente: a segunda
  // esbarra na chave única. Medido contra Postgres real em
  // test/parecer-unico-por-versao.integration.test.ts.
  it('conflito de chave única (P2002) no upsert não aborta: segue para a trava condicional', async () => {
    const prisma = {
      repoItem: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaDaTravaDeParecer

    const ok = await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
    })

    // Perdeu a corrida pela trava, mas chegou a disputá-la.
    expect(ok).toBe(false)
    expect(prisma.repoItem.updateMany).toHaveBeenCalledTimes(1)
  })

  it('qualquer outro erro do upsert continua subindo', async () => {
    const queda = Object.assign(new Error('conexão perdida'), { code: 'P1001' })
    const prisma = {
      repoItem: {
        upsert: vi.fn(async () => {
          throw queda
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as unknown as PrismaDaTravaDeParecer

    await expect(
      adquirirTravaDeParecer({
        prisma,
        projectId: 'proj-1',
        numeroDoPr: 42,
        headSha: 'abc',
        agora: new Date('2026-09-15T00:00:00Z'),
      })
    ).rejects.toBe(queda)
    expect(prisma.repoItem.updateMany).not.toHaveBeenCalled()
  })
})

describe('liberarTravaDeParecer', () => {
  it('zera a validade só da ficha deste PR E deste commit', async () => {
    const prisma = prismaFake(1)

    await liberarTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
    })

    expect(prisma.repoItem.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'proj-1', tipo: 'pr', numero: 42, parecerTravaHeadSha: 'abc' },
      data: { parecerTravadoAte: null },
    })
  })
})

describe('assentarTravaDeParecer', () => {
  it('encurta a validade para a folga de 3 min, só da ficha deste PR E deste commit', async () => {
    const prisma = prismaFake(1)

    await assentarTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:10:00Z'),
    })

    expect(FOLGA_APOS_PUBLICAR_MS).toBe(3 * 60_000)
    expect(prisma.repoItem.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'proj-1', tipo: 'pr', numero: 42, parecerTravaHeadSha: 'abc' },
      data: { parecerTravadoAte: new Date('2026-09-15T00:13:00Z') },
    })
  })

  it('aceita uma folga explícita', async () => {
    const prisma = prismaFake(1)

    await assentarTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
      duracaoMs: 60_000,
    })

    const chamada = (prisma.repoItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(chamada.data.parecerTravadoAte).toEqual(new Date('2026-09-15T00:01:00Z'))
  })
})

describe('esquema do banco', () => {
  it('garante que parecerTravadoAte e parecerTravaHeadSha existem no model RepoItem do schema.prisma', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const schemaConteudo = readFileSync(schemaPath, 'utf8')

    // We just search the whole file for these exact definitions, as that's unique enough for a drift guard
    expect(schemaConteudo).toMatch(/parecerTravadoAte\s+DateTime\?\s+@map\("parecer_travado_ate"\)/)
    expect(schemaConteudo).toMatch(
      /parecerTravaHeadSha\s+String\?\s+@map\("parecer_trava_head_sha"\)/
    )
    // And ensure they are in the RepoItem block
    const repoItemStart = schemaConteudo.indexOf('model RepoItem {')
    const nextModelStart = schemaConteudo.indexOf('model ', repoItemStart + 1)
    const repoItemBody = schemaConteudo.slice(
      repoItemStart,
      nextModelStart !== -1 ? nextModelStart : undefined
    )

    expect(repoItemBody).toContain('parecerTravadoAte')
    expect(repoItemBody).toContain('parecerTravaHeadSha')
  })
})
