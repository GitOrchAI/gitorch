import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { telegramPlugin } from './telegram.js'

// A resposta do dono à pergunta "a qual tarefa este pull request pertence?"
// pelo caminho REAL do serviço: o plugin do Telegram monta o
// `AgentQuestionService` com a lista de tratadores por prefixo, e `answer()`
// escolhe o tratador pelo `dedupKey`. Antes, o prefixo `vinculo-da-tarefa:`
// não estava na lista e a resposta ficava guardada sem efeito nenhum. Este
// teste falha se a entrada sair da lista.
const PROJETO = {
  wingId: 'acme/api',
  userId: 'user_1',
  encryptedClientToken: null,
  autonomia: 'cuidar',
}

function pergunta(opcoes: Array<{ label: string; value: string }>) {
  return {
    id: 'q_1',
    projectId: 'proj_1',
    userId: 'user_1',
    text: 'A qual tarefa ele pertence?',
    options: opcoes,
    status: 'open',
    dedupKey: 'vinculo-da-tarefa:acme/api:590',
    project: { wingId: 'acme/api', autonomia: 'cuidar' },
  }
}

function buildFakePrisma(opcoes: Array<{ label: string; value: string }>) {
  const upserts: Array<{ update: Record<string, unknown> }> = []
  return {
    _upserts: upserts,
    agentQuestion: {
      findUnique: vi.fn(async () => pergunta(opcoes)),
      update: vi.fn(async () => ({ ...pergunta(opcoes), status: 'answered' })),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      update: vi.fn(async () => ({})),
    },
    repoItem: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: { update: Record<string, unknown> }) => {
        upserts.push(args)
        return {}
      }),
    },
    event: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
  }
}

describe('resposta do dono ao vínculo da tarefa (real seam)', () => {
  const envOriginal: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const chave of ['GITORCH_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']) {
      envOriginal[chave] = process.env[chave]
      delete process.env[chave]
    }
  })

  afterEach(() => {
    for (const [chave, valor] of Object.entries(envOriginal)) {
      if (valor === undefined) delete process.env[chave]
      else process.env[chave] = valor
    }
    vi.restoreAllMocks()
  })

  async function montar(opcoes: Array<{ label: string; value: string }>) {
    const prisma = buildFakePrisma(opcoes)
    const app = Fastify({ logger: false })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    await app.register(telegramPlugin)
    const perguntas = app.agentQuestionService
    if (!perguntas) throw new Error('o plugin do Telegram não decorou o serviço de perguntas')
    return { app, prisma, perguntas }
  }

  test('clicar numa tarefa candidata chega ao tratador e grava issue_number com vinculo_origem "dono"', async () => {
    const { app, prisma, perguntas } = await montar([
      { label: '#713 — wishlist', value: 'vinculo-issue-713' },
      { label: 'Nenhuma destas', value: 'nenhuma-destas' },
    ])

    await perguntas.answer('q_1', 'vinculo-issue-713', 'telegram')

    expect(prisma._upserts).toHaveLength(1)
    expect(prisma._upserts[0]!.update).toMatchObject({ issueNumber: 713, vinculoOrigem: 'dono' })
    expect(prisma.agentQuestion.update).toHaveBeenCalled()
    await app.close()
  })

  test('"nenhuma destas" é registrada como respondida e não mexe na ficha', async () => {
    const { app, prisma, perguntas } = await montar([
      { label: '#713 — wishlist', value: 'vinculo-issue-713' },
      { label: 'Nenhuma destas', value: 'nenhuma-destas' },
    ])

    await perguntas.answer('q_1', 'nenhuma-destas', 'telegram')

    expect(prisma._upserts).toHaveLength(0)
    expect(prisma.agentQuestion.update).toHaveBeenCalled()
    await app.close()
  })

  test('falha ao gravar mantém a pergunta aberta (a exceção sobe e nada é marcado como respondido)', async () => {
    const { app, prisma, perguntas } = await montar([{ label: '#713', value: 'vinculo-issue-713' }])
    prisma.repoItem.upsert.mockRejectedValueOnce(new Error('banco fora'))

    await expect(perguntas.answer('q_1', 'vinculo-issue-713', 'telegram')).rejects.toThrow(
      'banco fora'
    )
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
    await app.close()
  })
})
