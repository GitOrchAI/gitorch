import { describe, it, expect, vi } from 'vitest'
import { adquirirTravaDeParecer, type PrismaDaTravaDeParecer } from './trava-de-parecer.js'
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
