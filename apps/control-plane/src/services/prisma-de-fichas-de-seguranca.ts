// O pedaço do Prisma que a sondagem e a aplicação das melhorias de segurança
// usam, como contrato estrutural: o cliente de verdade o satisfaz e os testes
// de unidade o trocam por um em memória.

import type { Prisma } from '@prisma/client'
import type { PrismaDoRegistroNoPainel } from './registro-no-painel.js'

type ChaveDaFicha = { projectId_tipo_numero: { projectId: string; tipo: string; numero: number } }

export interface PrismaDeFichas {
  repoItem: {
    findUnique(args: { where: ChaveDaFicha }): Promise<{ estado: unknown } | null>
    findMany(args: {
      where: { projectId: { in: string[] }; tipo: string; numero: number }
      select: { projectId: true; estado: true }
    }): Promise<Array<{ projectId: string; estado: unknown }>>
    upsert(args: {
      where: ChaveDaFicha
      create: { projectId: string; tipo: string; numero: number; estado: Prisma.InputJsonObject }
      update: { estado: Prisma.InputJsonObject }
    }): Promise<unknown>
  }
}

export interface PrismaDePerguntas {
  agentQuestion: {
    findFirst(args: {
      where: {
        projectId: string
        dedupKey: string
        status: string | { in: string[] }
        answer?: string
      }
      select: { id: true }
    }): Promise<{ id: string } | null>
  }
}

export type PrismaDoAplicador = PrismaDeFichas & PrismaDoRegistroNoPainel & PrismaDePerguntas
export type PrismaDoDesfazer = PrismaDeFichas & PrismaDoRegistroNoPainel
