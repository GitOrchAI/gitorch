import { describe, it, expect, vi } from 'vitest'
import {
  atualizarFichaDoItem,
  lerFichaDoItem,
  type PrismaDaFichaDoItem,
  type RepoItemRecord,
} from './ficha-do-item.js'

type ArgsUpsert = Parameters<PrismaDaFichaDoItem['repoItem']['upsert']>[0]
type ArgsFindUnique = Parameters<PrismaDaFichaDoItem['repoItem']['findUnique']>[0]

function prismaFake(): PrismaDaFichaDoItem & { chamadas: unknown[] } {
  const linhas = new Map<string, Record<string, unknown>>()
  const chave = (projectId: string, tipo: string, numero: number) =>
    `${projectId}:${tipo}:${numero}`
  return {
    chamadas: [],
    repoItem: {
      upsert: vi.fn(async (args: ArgsUpsert) => {
        const k = chave(
          args.where.projectId_tipo_numero.projectId,
          args.where.projectId_tipo_numero.tipo,
          args.where.projectId_tipo_numero.numero
        )
        const existente = linhas.get(k)
        const linha = existente
          ? { ...existente, ...args.update }
          : { id: 'novo-id', ...args.create }
        linhas.set(k, linha)
        return linha
      }),
      findUnique: vi.fn(async (args: ArgsFindUnique) => {
        const k = chave(
          args.where.projectId_tipo_numero.projectId,
          args.where.projectId_tipo_numero.tipo,
          args.where.projectId_tipo_numero.numero
        )
        return (linhas.get(k) ?? null) as RepoItemRecord | null
      }),
    },
  }
}

describe('atualizarFichaDoItem', () => {
  it('cria a ficha quando ela ainda não existe', async () => {
    const prisma = prismaFake()
    const ficha = await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'open', verificacao: 'pendente' },
    })
    expect(ficha).toMatchObject({ estado: { status: 'open', verificacao: 'pendente' } })
    expect(prisma.repoItem.upsert).toHaveBeenCalledTimes(1)
  })

  it('atualiza o estado sem apagar origem/entendimento já gravados', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'merged' },
    })
    expect(ficha.estado).toEqual({ status: 'merged' })
    // origem não foi passada na 2ª chamada — o upsert.update só carrega o que
    // mudou, então a origem gravada na 1ª chamada continua na linha.
    expect(ficha.origem).toBe('jules_gitorch')
  })
})

describe('lerFichaDoItem', () => {
  it('devolve null quando a ficha não existe', async () => {
    const prisma = prismaFake()
    expect(
      await lerFichaDoItem({ prisma, projectId: 'proj-1', tipo: 'issue', numero: 7 })
    ).toBeNull()
  })
})
