import { describe, expect, it } from 'vitest'
import { nivelDoRepositorio, type PrismaDeNivel } from './nivel-do-repositorio.js'

interface Linha {
  id: string
  wingId: string
  isActive: boolean
  autonomia: string | null
}

function prismaCom(linhas: Linha[]): PrismaDeNivel {
  return {
    project: {
      findMany: async ({ where }) =>
        linhas
          .filter((l) => l.wingId === where.wingId && l.isActive === where.isActive)
          .map((l) => ({ id: l.id, autonomia: l.autonomia })),
    },
  }
}

const REPO = 'cliente/api'

describe('nivelDoRepositorio — a autonomia é do projeto, não do nome do repositório', () => {
  const linhas: Linha[] = [
    { id: 'p-cuidar', wingId: REPO, isActive: true, autonomia: 'cuidar' },
    { id: 'p-olhar', wingId: REPO, isActive: true, autonomia: 'so_olhar' },
    { id: 'p-inativo', wingId: REPO, isActive: false, autonomia: 'cuidar' },
  ]

  it('com o projeto conhecido, cada um usa a SUA autonomia', async () => {
    const prisma = prismaCom(linhas)
    expect(await nivelDoRepositorio(prisma, REPO, 'p-cuidar')).toBe('cuidar')
    expect(await nivelDoRepositorio(prisma, REPO, 'p-olhar')).toBe('so_olhar')
  })

  it('projeto inativo não empresta nem herda autonomia', async () => {
    const prisma = prismaCom(linhas)
    // O inativo "cuidar" não vale: sem projeto ativo com esse id, cai no
    // conjunto dos ativos, e entre dois níveis vale o mais restrito.
    expect(await nivelDoRepositorio(prisma, REPO, 'p-inativo')).toBe('so_olhar')
    expect(
      await nivelDoRepositorio(
        prismaCom([{ id: 'x', wingId: REPO, isActive: false, autonomia: 'cuidar' }]),
        REPO
      )
    ).toBeNull()
  })

  it('sem saber o projeto e com níveis diferentes, vale o MAIS RESTRITO', async () => {
    expect(await nivelDoRepositorio(prismaCom(linhas), REPO)).toBe('so_olhar')
  })

  it('um único projeto ativo: o nível dele, com ou sem id', async () => {
    const prisma = prismaCom([{ id: 'a', wingId: REPO, isActive: true, autonomia: 'sugerir' }])
    expect(await nivelDoRepositorio(prisma, REPO)).toBe('sugerir')
    expect(await nivelDoRepositorio(prisma, REPO, 'a')).toBe('sugerir')
  })

  it('repositório sem projeto ativo: null (a porta recusa)', async () => {
    expect(await nivelDoRepositorio(prismaCom(linhas), 'estranho/repo')).toBeNull()
  })

  it('autonomia ausente numa das linhas: null, o lado seguro', async () => {
    const prisma = prismaCom([
      { id: 'a', wingId: REPO, isActive: true, autonomia: null },
      { id: 'b', wingId: REPO, isActive: true, autonomia: 'cuidar' },
    ])
    expect(await nivelDoRepositorio(prisma, REPO)).toBeNull()
  })
})
