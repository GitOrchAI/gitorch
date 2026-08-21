import { describe, expect, it } from 'vitest'
import { projetoParaDesejo, projetosParaDesejo } from './projetos-do-desejo.js'

// As duas portas do pedido (a tela e o mensageiro) filtravam projeto de jeitos
// diferentes: uma exigia projeto ativo, a outra não. Estes testes prendem a
// regra ÚNICA — e, principalmente, que ela é a MESMA nas duas consultas.

interface LinhaDeProjeto {
  id: string
  name: string
  wingId: string
  userId: string | null
  isActive: boolean
  createdAt: Date
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fake do Prisma para `projects`: só o `where` que os serviços usam. Mesmo
// padrão dos fakes de telegram-link.test.ts — nada de banco nestes testes.
function fakePrisma(linhas: LinhaDeProjeto[]) {
  const casa = (linha: LinhaDeProjeto, where: any): boolean => {
    if (where.id !== undefined && linha.id !== where.id) return false
    if (where.userId !== undefined && linha.userId !== where.userId) return false
    if (where.isActive !== undefined && linha.isActive !== where.isActive) return false
    return true
  }
  return {
    project: {
      findMany: async ({ where }: any) => linhas.filter((l) => casa(l, where ?? {})),
      findFirst: async ({ where }: any) => linhas.find((l) => casa(l, where ?? {})) ?? null,
    },
  }
}

const ATIVO: LinhaDeProjeto = {
  id: 'p1',
  name: 'Loja',
  wingId: 'dono/loja',
  userId: 'user_a',
  isActive: true,
  createdAt: new Date('2020-01-01'),
}

const DESATIVADO: LinhaDeProjeto = {
  id: 'p2',
  name: 'Site velho',
  wingId: 'dono/site-velho',
  userId: 'user_a',
  isActive: false,
  createdAt: new Date('2020-01-02'),
}

const DE_OUTRA_CONTA: LinhaDeProjeto = {
  id: 'p3',
  name: 'Alheio',
  wingId: 'outro/alheio',
  userId: 'user_b',
  isActive: true,
  createdAt: new Date('2020-01-03'),
}

describe('projetosParaDesejo', () => {
  it('lista só os projetos do dono', async () => {
    const prisma = fakePrisma([ATIVO, DE_OUTRA_CONTA])
    const r = await projetosParaDesejo(prisma as any, 'user_a')
    expect(r).toEqual([{ id: 'p1', nome: 'Loja', repo: 'dono/loja' }])
  })

  it('projeto desativado não aparece: o scheduler não trabalharia nele', async () => {
    const prisma = fakePrisma([ATIVO, DESATIVADO])
    const r = await projetosParaDesejo(prisma as any, 'user_a')
    expect(r.map((p) => p.id)).toEqual(['p1'])
  })
})

describe('projetoParaDesejo', () => {
  it('acha o projeto do dono pelo id', async () => {
    const prisma = fakePrisma([ATIVO, DE_OUTRA_CONTA])
    const r = await projetoParaDesejo(prisma as any, { projectId: 'p1', userId: 'user_a' })
    expect(r).toEqual({ id: 'p1', githubRepo: 'dono/loja' })
  })

  it('projeto de outra conta não é achado', async () => {
    const prisma = fakePrisma([ATIVO, DE_OUTRA_CONTA])
    const r = await projetoParaDesejo(prisma as any, { projectId: 'p3', userId: 'user_a' })
    expect(r).toBeNull()
  })

  // O defeito de verdade: a porta HTTP aceitava o projeto desativado que o
  // mensageiro recusava. O mesmo dono, o mesmo projeto, duas respostas.
  it('projeto desativado é recusado, igual ao mensageiro', async () => {
    const prisma = fakePrisma([ATIVO, DESATIVADO])
    const r = await projetoParaDesejo(prisma as any, { projectId: 'p2', userId: 'user_a' })
    expect(r).toBeNull()
  })
})
