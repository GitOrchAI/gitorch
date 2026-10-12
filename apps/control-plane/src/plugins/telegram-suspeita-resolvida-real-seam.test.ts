import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { telegramPlugin } from './telegram.js'
import {
  RESPOSTA_SEGUIR_COM_A_TAREFA,
  dedupKeyDaSuspeita,
} from '../services/suspeita-de-tarefa-resolvida.js'

// A resposta do dono à pergunta "esta tarefa parece já resolvida?" pelo caminho
// REAL do serviço de perguntas: o plugin do Telegram escolhe o tratador pelo
// prefixo da chave. Este teste falha se a entrada sair da lista (a resposta
// ficaria guardada e a tarefa presa).
const ATUALIZADA = '2026-01-12T10:00:00Z'
const CHAVE = dedupKeyDaSuspeita('acme/api', 46, ATUALIZADA)
const OPCOES = [
  { label: 'Já está entregue: fechar a tarefa', value: 'suspeita-fechar' },
  { label: 'Ainda falta fazer: seguir com a tarefa', value: RESPOSTA_SEGUIR_COM_A_TAREFA },
]

function buildFakePrisma() {
  const upserts: Array<{ update: Record<string, unknown> }> = []
  const pergunta = {
    id: 'q_1',
    projectId: 'proj_1',
    userId: 'user_1',
    text: 'A tarefa #46 parece já estar resolvida.',
    options: OPCOES,
    status: 'open',
    dedupKey: CHAVE,
    project: { wingId: 'acme/api', autonomia: 'cuidar' },
  }
  return {
    _upserts: upserts,
    agentQuestion: {
      findUnique: vi.fn(async () => pergunta),
      update: vi.fn(async () => ({ ...pergunta, status: 'answered' })),
    },
    project: {
      findUnique: vi.fn(async () => ({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
        autonomia: 'cuidar',
      })),
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

describe('resposta do dono à suspeita de tarefa já resolvida (real seam)', () => {
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

  test('"seguir com a tarefa" chega ao tratador, devolve a tarefa à fila na ficha e não escreve no GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const prisma = buildFakePrisma()
    const app = Fastify({ logger: false })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    await app.register(telegramPlugin)

    await app.agentQuestionService!.answer('q_1', RESPOSTA_SEGUIR_COM_A_TAREFA, 'telegram')

    expect(prisma._upserts.length).toBeGreaterThan(0)
    const gravou = prisma._upserts.some((u) =>
      JSON.stringify(u.update).includes('"veredito":"descartada"')
    )
    expect(gravou).toBe(true)
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('api.github.com'))).toEqual([])
    expect(prisma.agentQuestion.update).toHaveBeenCalled()
    await app.close()
  })
})
