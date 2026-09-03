import type { Prisma, PrismaClient } from '@prisma/client'
import type { CortexClient, CortexDrawer } from '@gitorch/cortex'
import { configuracaoAPartirDaResposta } from './como-o-projeto-publica.js'

// Só o que o serviço usa do Prisma — permite injetar um fake nos testes
// (mesmo padrão de environment.ts/engine-connection.ts), nunca banco real.
// `project` entrou aqui quando a resposta do dono passou a virar
// configuração do projeto (D49) — antes ela morria na tabela de dúvidas.
type PrismaLike = Pick<PrismaClient, 'agentQuestion' | 'event' | 'project'>

// Só o que answer() usa do Cortex — permite injetar um fake nos testes (mesmo
// padrão de repo-context-cortex.ts).
type CortexWriter = Pick<CortexClient, 'writeDrawer'>

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

/** L4-T2 (D63): a resposta a uma dúvida de decisão de automação
 *  (`dedupKey` começando com `automacao:`) vira ação — deletar via PR,
 *  reajustar para incidente normal, manter e fechar, ou só registrar texto
 *  livre. C4 (fix-up): chamada ANTES de marcar `answered` — uma falha aqui
 *  agora IMPEDE o `answer` (a pergunta continua `open` para nova tentativa),
 *  ao contrário do best-effort antigo que fingia sucesso. */
export type AoResponderAutomacaoFn = (args: {
  dedupKey: string
  resposta: string
  projectId: string
  autonomia: string | null | undefined
}) => Promise<void>

/** L4-T3: a resposta do dono a uma dúvida escalada do dev assíncrono
 *  (dedupKey `duvida-dev:<repo>:<issue>:<hash>`) RETOMA a sessão dele —
 *  `AgentQuestionService` não sabe nada de Jules/sessões; só delega para cá
 *  (`services/retomar-sessao-com-resposta.ts`). MESMA disciplina de
 *  `aoResponderAutomacao`: chamada ANTES de marcar `answered`, uma falha
 *  (lançada, nunca engolida) mantém a pergunta `open` para nova tentativa. */
export type AoResponderDuvidaDoDevFn = (args: {
  dedupKey: string
  resposta: string
  opcoes: AgentQuestionOption[]
}) => Promise<void>

export interface AgentQuestionServiceDeps {
  notify?: NotifyFn
  /** Grava a decisão respondida na memória de longo prazo (Cortex) — best-effort. */
  cortex?: CortexWriter
  now?: () => Date
  aoResponderAutomacao?: AoResponderAutomacaoFn
  aoResponderDuvidaDoDev?: AoResponderDuvidaDoDevFn
  /** C4 (fix-up L4-T2): logger injetado para a falha de `aoResponderAutomacao`
   *  (e, desde L4-T3, de `aoResponderDuvidaDoDev`) — NUNCA `console.warn` (o
   *  padrão antigo, que não aparecia em lugar nenhum monitorado). Produção
   *  passa `app.log.error`. */
  onError?: (mensagem: string) => void
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

  /**
   * Registra a resposta do dono. C4 (fix-up L4-T2): para dedupKey de decisão
   * de automação (`automacao:*`), a AÇÃO (`aoResponderAutomacao`) roda
   * PRIMEIRO — se ela lançar, a exceção sobe e NADA é gravado (a pergunta
   * continua `open`, pronta para nova tentativa). Só depois disso grava
   * `answer/answeredAt/answeredVia` + `status: 'answered'`, e em seguida
   * grava a DECISÃO na memória de longo prazo (Cortex) do projeto — a fonte
   * que os agentes consultam antes de perguntar de novo (ver `ask`/dedupKey).
   * O Cortex (e a configuração do projeto, D49) continuam BEST-EFFORT: se a
   * gravação falhar, loga e segue — o `answer` em si é a fonte de verdade
   * dali em diante, nunca desfeito por uma falha de memória.
   *
   * IDEMPOTENTE: se a questão já está `answered`, devolve o estado atual sem
   * regravar nem duplicar a memória nem repetir a ação (responder 2x — ex.:
   * Telegram reentrega o callback_query — é inofensivo).
   *
   * `questionId` inexistente devolve `null` sem lançar.
   */
  async answer(
    questionId: string,
    value: string,
    via: 'telegram' | 'panel'
  ): Promise<AgentQuestionRecord | null> {
    const existing = await this.prisma.agentQuestion.findUnique({
      where: { id: questionId },
      include: { project: { select: { wingId: true } } },
    })
    if (!existing) {
      console.warn('[agent-question] answer: dúvida não encontrada', { questionId })
      return null
    }
    if (existing.status === 'answered') {
      return existing as unknown as AgentQuestionRecord
    }

    // C4 (fix-up L4-T2): para dedupKey de decisão de automação, a AÇÃO roda
    // ANTES de marcar `answered` — o antigo best-effort (ação DEPOIS, falha
    // vira warn e engolida) fingia sucesso: o dono clicava "Deletar", via a
    // pergunta sumir, e o workflow continuava lá porque a ação de verdade
    // (abrir o PR) tinha falhado em silêncio. Agora, se a ação falhar, a
    // pergunta continua `open` — nova tentativa (Telegram/painel respondem
    // de novo) — e o erro é logado pelo logger INJETADO (nunca
    // `console.warn`, que não aparece em monitoramento nenhum). As outras
    // perguntas (sem esse prefixo) mantêm a ordem de sempre.
    if (existing.dedupKey?.startsWith('automacao:') && this.deps.aoResponderAutomacao) {
      const projeto = await this.prisma.project.findUnique({
        where: { id: existing.projectId },
        select: { autonomia: true },
      })
      try {
        await this.deps.aoResponderAutomacao({
          dedupKey: existing.dedupKey,
          resposta: value,
          projectId: existing.projectId,
          autonomia: (projeto as { autonomia?: string | null } | null)?.autonomia,
        })
      } catch (err) {
        const mensagem = err instanceof Error ? err.message : String(err)
        this.deps.onError?.(
          `[agent-question] decisão de automação falhou — pergunta ${questionId} continua open: ${mensagem}`
        )
        throw err
      }
    }

    // L4-T3: dedupKey de dúvida escalada do dev assíncrono — a resposta do
    // dono RETOMA a sessão dele (`retomar-sessao-com-resposta.ts`). MESMA
    // disciplina de `automacao:` acima: a ação roda ANTES de marcar
    // `answered`; falha (lançada, nunca engolida) mantém a pergunta `open`
    // para nova tentativa — sem isto, o dono clicaria "Sim", veria a
    // pergunta sumir, e o dev continuaria parado para sempre porque a
    // entrega de verdade (`responderSessaoJules`) falhou em silêncio.
    if (existing.dedupKey?.startsWith('duvida-dev:') && this.deps.aoResponderDuvidaDoDev) {
      try {
        await this.deps.aoResponderDuvidaDoDev({
          dedupKey: existing.dedupKey,
          resposta: value,
          opcoes: Array.isArray(existing.options)
            ? (existing.options as unknown as AgentQuestionOption[])
            : [],
        })
      } catch (err) {
        const mensagem = err instanceof Error ? err.message : String(err)
        this.deps.onError?.(
          `[agent-question] retomada da sessão do dev falhou — pergunta ${questionId} continua open: ${mensagem}`
        )
        throw err
      }
    }

    const now = this.deps.now ? this.deps.now() : new Date()
    const updated = await this.prisma.agentQuestion.update({
      where: { id: questionId },
      data: { answer: value, answeredAt: now, answeredVia: via, status: 'answered' },
    })
    const question = updated as unknown as AgentQuestionRecord

    // A resposta vira CONFIGURAÇÃO do projeto, não só uma linha na tabela de
    // dúvidas (D49). Sem isto o produto perguntava "como este projeto vai ao
    // ar?", guardava a resposta e continuava adivinhando na hora de decidir —
    // gastando a paciência do dono sem mudar nada.
    const configuracao = configuracaoAPartirDaResposta({
      // `dedupKey` nulo é dúvida antiga, de antes da chave existir: não casa
      // com nenhuma pergunta do catálogo, e é isso que a string vazia diz.
      dedupKey: existing.dedupKey ?? '',
      repositorio: existing.project.wingId,
      resposta: value,
    })
    if (configuracao) {
      try {
        const projeto = await this.prisma.project.findUnique({
          where: { id: existing.projectId },
          select: { runtimeConfig: true },
        })
        // Mescla rasa, e nunca substituição: o `runtimeConfig` carrega a
        // configuração inteira do projeto (motores, ambientes, plano), e
        // sobrescrever apagaria tudo o que não é publicação.
        const atual = (projeto?.runtimeConfig ?? {}) as Record<string, unknown>
        await this.prisma.project.update({
          where: { id: existing.projectId },
          data: { runtimeConfig: { ...atual, ...configuracao } },
        })
      } catch (err) {
        // Best-effort, como a gravação na memória logo abaixo: a resposta já
        // está no banco e o dono não pode ver o botão falhar por causa disto.
        // A próxima resposta (ou o painel) grava de novo.
        console.warn('[agent-question] não deu para aplicar a resposta na configuração', {
          questionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (this.deps.cortex) {
      try {
        await this.deps.cortex.writeDrawer(
          buildDecisionDrawer(existing.project.wingId, questionId, existing.text, value, now)
        )
      } catch (err) {
        // Best-effort (spec W3.2.3): a memória nunca desfaz o answer, que já
        // está gravado no banco (fonte de verdade). Loga a CAUSA, não o
        // conteúdo da decisão.
        console.warn(
          '[agent-question] gravação no Cortex falhou (best-effort, answer já gravado)',
          {
            questionId,
            error: err instanceof Error ? err.message : String(err),
          }
        )
      }
    }

    return question
  }

  /**
   * Dúvidas do DONO (userId), em qualquer projeto — abertas primeiro, depois
   * por `createdAt` (mais recente primeiro). Alimenta o painel (GET .../
   * agent-questions, rota de outra task).
   */
  async listForUser(userId: string): Promise<AgentQuestionRecord[]> {
    const rows = await this.prisma.agentQuestion.findMany({ where: { userId } })
    return sortOpenFirst(rows as unknown as AgentQuestionRecord[])
  }

  /** Dúvidas ABERTAS de um projeto — mesma ordenação de `listForUser`. */
  async listOpen(projectId: string): Promise<AgentQuestionRecord[]> {
    const rows = await this.prisma.agentQuestion.findMany({
      where: { projectId, status: 'open' },
    })
    return sortOpenFirst(rows as unknown as AgentQuestionRecord[])
  }
}

// Abertas primeiro (open antes de answered/expired), depois mais recente
// primeiro — o Prisma não ordena por um valor de string "customizado"
// (open < answered não é alfabético), então a ordenação é em memória.
function sortOpenFirst(rows: AgentQuestionRecord[]): AgentQuestionRecord[] {
  const rank = (status: string): number => (status === 'open' ? 0 : 1)
  return [...rows].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status)
    if (byStatus !== 0) return byStatus
    return b.createdAt.getTime() - a.createdAt.getTime()
  })
}

// Molde da gaveta de decisão: id DETERMINÍSTICO (writeDrawer faz upsert —
// mesmo padrão de repo-context-cortex.ts baseDrawer) garante que, mesmo que
// este método fosse chamado de novo, nunca duplicaria a memória (a guarda
// real de idempotência é o early-return em `answer` acima; o id
// determinístico é defesa em profundidade).
function buildDecisionDrawer(
  wingId: string,
  questionId: string,
  text: string,
  value: string,
  now: Date
): CortexDrawer {
  const ts = now.toISOString()
  return {
    id: `agent-question:${questionId}`,
    wingId,
    roomId: 'decisoes-de-rumo',
    hallId: 'agent-question',
    content: `Decisão de rumo registrada pelo dono: ${text} → ${value}`,
    importance: 0.6,
    emotionalWeight: 0,
    createdAt: ts,
    validFrom: ts,
    confidence: 0.95,
    tags: ['decisao', 'rumo', 'agent-question'],
  }
}
