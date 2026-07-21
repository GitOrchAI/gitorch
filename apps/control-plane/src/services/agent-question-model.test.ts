import { describe, expect, it } from 'vitest'
import type { AgentQuestion, Prisma } from '@prisma/client'

// Task W3.2.1: prova de que o Prisma Client GERADO tipa o modelo novo
// (AgentQuestion) — se o campo não existisse no schema/client, este arquivo
// nem compilaria (tsc/vitest com typecheck de tipos via `import type`
// falhariam antes de qualquer asserção rodar). Não toca banco nenhum: é
// tipagem, não integração.
describe('AgentQuestion — tipagem do Prisma Client gerado (W3.2.1)', () => {
  it('o shape do registro tem todos os campos do spec', () => {
    const record: AgentQuestion = {
      id: 'q1',
      projectId: 'p1',
      userId: 'u1',
      text: 'As páginas usam 3 azuis diferentes. Qual é o azul oficial?',
      context: 'Home, Preço e Painel',
      options: [
        { label: '#2563EB', value: '#2563EB' },
        { label: '#1E40AF', value: '#1E40AF' },
      ],
      dedupKey: 'cor-oficial-site',
      status: 'open',
      answer: null,
      answeredAt: null,
      answeredVia: null,
      telegramMessageId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    expect(record.status).toBe('open')
    expect(record.dedupKey).toBe('cor-oficial-site')
    expect(Array.isArray(record.options)).toBe(true)
  })

  it('AgentQuestionCreateInput aceita os campos de criação (options/dedupKey/context)', () => {
    const input: Prisma.AgentQuestionCreateInput = {
      project: { connect: { id: 'p1' } },
      userId: 'u1',
      text: 'Qual é o azul oficial?',
      context: 'evidência',
      options: [{ label: '#2563EB', value: '#2563EB' }],
      dedupKey: 'cor-oficial-site',
    }

    expect(input.userId).toBe('u1')
    expect(input.dedupKey).toBe('cor-oficial-site')
  })

  it('AgentQuestionUpdateInput aceita os campos de resposta (answer/answeredVia/status)', () => {
    const input: Prisma.AgentQuestionUpdateInput = {
      answer: '#2563EB',
      answeredAt: new Date(),
      answeredVia: 'telegram',
      status: 'answered',
    }

    expect(input.status).toBe('answered')
  })
})
