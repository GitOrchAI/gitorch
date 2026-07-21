import type { Prisma, PrismaClient } from '@prisma/client'

// Só o que o serviço usa do Prisma — permite injetar um fake nos testes
// (mesmo padrão de environment.ts/engine-connection.ts), nunca banco real.
type PrismaLike = Pick<PrismaClient, 'agentQuestion' | 'event'>

export interface AgentQuestionOption {
  label: string
  value: string
}

/** Espelha o modelo Prisma AgentQuestion (ver schema.prisma, W3.2.1). */
export interface AgentQuestionRecord {
  id: string
  projectId: string
  userId: string
  text: string
  context: string | null
  options: AgentQuestionOption[] | Prisma.JsonValue
  dedupKey: string | null
  status: string
  answer: string | null
  answeredAt: Date | null
  answeredVia: string | null
  telegramMessageId: number | null
  createdAt: Date
  updatedAt: Date
}

export interface AskInput {
  text: string
  context?: string
  options?: AgentQuestionOption[]
  dedupKey?: string
}

export interface AskResult {
  /** true = a pergunta já tinha sido respondida antes (mesmo dedupKey/projeto); nada foi criado. */
  deduped: boolean
  question: AgentQuestionRecord
}

/**
 * Notifica o dono da dúvida nova (Telegram — implementação real vem no épico
 * W3.3). Injetável e OPCIONAL: best-effort por contrato — uma falha aqui
 * nunca pode impedir a dúvida de existir (o painel é sempre o fallback).
 */
export type NotifyFn = (question: AgentQuestionRecord) => Promise<void>

export interface AgentQuestionServiceDeps {
  notify?: NotifyFn
  now?: () => Date
}

/**
 * Registro de dúvida do agente (human-in-the-loop, épico W3) — a API interna
 * que qualquer agente chama quando esbarra numa decisão de rumo NÃO
 * documentada. Fonte ÚNICA consumida pelo painel e pelo Telegram (ver
 * docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md).
 */
export class AgentQuestionService {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly deps: AgentQuestionServiceDeps = {}
  ) {}

  /**
   * Registra uma dúvida. Se `dedupKey` é informado e já existe uma
   * AgentQuestion `answered` do MESMO projeto com a mesma chave, devolve a
   * decisão já tomada em vez de perguntar de novo (contrato central do
   * human-in-the-loop — o dono não quer ser perguntado 2x a mesma coisa).
   * Caso contrário, cria a dúvida (`status: 'open'`) + um Event
   * (`type: 'agent_question'`) no mesmo projeto para o painel, e dispara a
   * notificação injetada — BEST-EFFORT: uma falha no notify nunca impede a
   * criação (a dúvida já existe e aparece no painel de qualquer forma).
   */
  async ask(userId: string, projectId: string, input: AskInput): Promise<AskResult> {
    const { text, context, options = [], dedupKey } = input

    if (dedupKey !== undefined) {
      const already = await this.prisma.agentQuestion.findFirst({
        where: { projectId, dedupKey, status: 'answered' },
      })
      if (already) {
        return { deduped: true, question: already as unknown as AgentQuestionRecord }
      }
    }

    const created = await this.prisma.agentQuestion.create({
      data: {
        projectId,
        userId,
        text,
        options: options as unknown as Prisma.InputJsonValue,
        status: 'open',
        ...(context !== undefined ? { context } : {}),
        ...(dedupKey !== undefined ? { dedupKey } : {}),
      } as Prisma.AgentQuestionUncheckedCreateInput,
    })
    const question = created as unknown as AgentQuestionRecord

    await this.prisma.event.create({
      data: {
        projectId,
        type: 'agent_question',
        payload: { questionId: question.id, text } as unknown as Prisma.InputJsonValue,
      } as Prisma.EventUncheckedCreateInput,
    })

    if (this.deps.notify) {
      try {
        await this.deps.notify(question)
      } catch (err) {
        // Best-effort por contrato (spec W3.2): a notificação nunca pode
        // impedir a dúvida de existir. Loga a CAUSA (nunca o conteúdo da
        // dúvida/resposta — pode ser sensível) para diagnóstico, mas segue.
        console.warn('[agent-question] notify falhou (best-effort, dúvida já criada)', {
          questionId: question.id,
          projectId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { deduped: false, question }
  }
}
