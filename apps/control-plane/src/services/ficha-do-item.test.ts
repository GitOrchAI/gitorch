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

  it('grava issueNumber junto da origem (issue #877: PR 583 vira jules_gitorch com issue 580)', async () => {
    const prisma = prismaFake()
    const ficha = await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 583,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
      issueNumber: 580,
    })
    expect(ficha.origem).toBe('jules_gitorch')
    expect(ficha.issueNumber).toBe(580)
  })

  it('atualiza o estado sem apagar issueNumber já gravado quando issueNumber é omitido', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 583,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
      issueNumber: 580,
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 583,
      estado: { status: 'merged' },
    })
    expect(ficha.estado).toEqual({ status: 'merged' })
    expect(ficha.issueNumber).toBe(580)
  })
})

describe('atualizarFichaDoItem: a ficha só ganha vínculo, nunca perde', () => {
  const base = { projectId: 'proj-1', tipo: 'pr' as const, numero: 583 }

  it('issueNumber null depois de preenchido não apaga o vínculo (webhook sem issue de origem)', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
      issueNumber: 580,
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
      issueNumber: null,
    })
    expect(ficha.issueNumber).toBe(580)
  })

  it('origem null depois de preenchida não apaga a origem', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: 'assistente',
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: null,
    })
    expect(ficha.origem).toBe('assistente')
  })

  it('um valor novo e preenchido continua valendo (reclassificação de origem e de issue)', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: 'jules_fora',
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
      issueNumber: 580,
    })
    expect(ficha.origem).toBe('jules_gitorch')
    expect(ficha.issueNumber).toBe(580)
  })

  it('entendimento null depois de preenchido não apaga o entendimento', async () => {
    const prisma = prismaFake()
    const entendimento = {
      deOndeVeio: 'issue 580',
      oQueMuda: 'a ficha',
      queAjusteE: 'pequeno',
      porQueExiste: 'pedido do dono',
    }
    await atualizarFichaDoItem({ prisma, ...base, estado: { status: 'open' }, entendimento })
    const ficha = await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      entendimento: null,
    })
    expect(ficha.entendimento).toEqual(entendimento)
  })

  it('vinculoOrigem e conferencia são preenchidos e nunca regridem para null', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      tipo: 'issue',
      estado: { status: 'open' },
      vinculoOrigem: 'formal',
      conferencia: { veredito: 'ok' },
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      ...base,
      tipo: 'issue',
      estado: { status: 'open' },
      vinculoOrigem: null,
      conferencia: null,
    })
    expect(ficha.vinculoOrigem).toBe('formal')
    expect(ficha.conferencia).toEqual({ veredito: 'ok' })
  })

  it('sem estado a ficha existente mantém o estado e os campos derivados', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open', conflito: true, rascunho: false },
      origem: 'jules_gitorch',
      issueNumber: 580,
      vinculoOrigem: 'formal',
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      ...base,
      entendimento: {
        deOndeVeio: 'a',
        oQueMuda: 'b',
        queAjusteE: 'c',
        porQueExiste: 'd',
      },
    })
    expect(ficha.estado).toEqual({ status: 'open', conflito: true, rascunho: false })
    expect(ficha.origem).toBe('jules_gitorch')
    expect(ficha.issueNumber).toBe(580)
    expect(ficha.vinculoOrigem).toBe('formal')
  })

  it('sem estado numa ficha que não existe cria com um estado mínimo, nunca sem estado', async () => {
    const prisma = prismaFake()
    const ficha = await atualizarFichaDoItem({ prisma, ...base, origem: 'pessoa' })
    expect(ficha.estado).toEqual({ status: 'desconhecido' })
    expect(ficha.origem).toBe('pessoa')
  })

  it('com estado, o estado é trocado por inteiro mas os campos derivados ficam nas colunas', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open', conflito: true },
      origem: 'jules_gitorch',
      issueNumber: 580,
      vinculoOrigem: 'formal',
      conferencia: { veredito: 'ok' },
    })
    const ficha = await atualizarFichaDoItem({ prisma, ...base, estado: { status: 'merged' } })
    expect(ficha.estado).toEqual({ status: 'merged' })
    expect(ficha.origem).toBe('jules_gitorch')
    expect(ficha.issueNumber).toBe(580)
    expect(ficha.vinculoOrigem).toBe('formal')
    expect(ficha.conferencia).toEqual({ veredito: 'ok' })
  })

  it('o upsert não manda nenhuma coluna de vínculo no update quando o valor vem null', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: null,
      issueNumber: null,
      entendimento: null,
      vinculoOrigem: null,
      conferencia: null,
    })
    await atualizarFichaDoItem({
      prisma,
      ...base,
      estado: { status: 'open' },
      origem: null,
      issueNumber: null,
    })
    const segunda = (prisma.repoItem.upsert as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      update: Record<string, unknown>
    }
    expect(Object.keys(segunda.update)).toEqual(['estado'])
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
