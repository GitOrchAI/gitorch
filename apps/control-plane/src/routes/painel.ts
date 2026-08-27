import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveOwnerId } from '../lib/resolve-owner-id.js'
import { descreverEvento, papelDoAgente, estadoDoAgente } from '../services/descrever-evento.js'
import type { AgentQuestionRecord } from '../services/agent-question.js'

// Rotas do painel do owner (ui_kits/painel-owner/API.md do handoff GitOrch
// Design System). Nesta leva: pulso, agentes e responder-decisão ao vivo.
// Ritmo/entregas/histórico ficam para a leva 2 (a tela mostra selo "exemplo").
//
// Escopo por DONO resolvido por e-mail (mesma regra de routes/setup.ts — o
// helper compartilhado lib/resolve-owner-id.ts). Nenhuma resposta carrega
// userId, dedupKey, telegramMessageId ou o id do projeto.

const RATE_LIMIT_POLLING = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
const NAO_LOGADO = { error: 'UNAUTHORIZED: session required' }
const LIMITE_FRIO_SEGUNDOS = 3600

/** Cota de um motor (espelha o tipo do front — painel-tipos.ts). */
export interface MotorCota {
  id: string
  nome: string
  usado: number
  /** null quando o motor não reporta teto. */
  limite: number | null
  janela: string
  limite_conhecido: boolean
}

/**
 * Injeções opcionais (testes). Em produção os defaults são usados.
 * `lerCotas`: leitura das cotas dos motores do dono. Best-effort — sem uma
 * store de consumo persistida (há tarefa aberta no quadro: "a cota dos motores
 * não é gravada em lugar nenhum"), o default devolve `[]` e a tela degrada
 * com honestidade ("Nenhum motor conectado ainda."). Nunca inventa um `usado`.
 */
export interface PainelRoutesOpts {
  lerCotas?: (ownerId: string) => Promise<MotorCota[]>
  /**
   * Grava a resposta de uma decisão. Default: `app.agentQuestionService.answer`
   * — a MESMA função que o Telegram chama (services/telegram-bot.ts). Injetável
   * só nos testes. Idempotente e devolve `null` se a pergunta sumiu.
   */
  answerImpl?: (
    id: string,
    valor: string,
    via: 'telegram' | 'panel'
  ) => Promise<AgentQuestionRecord | null>
}

function nomeDoMotor(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    if (typeof p['engine'] === 'string' && p['engine']) return p['engine']
    if (typeof p['agent'] === 'string' && p['agent']) return p['agent']
    if (typeof p['runtime'] === 'string' && p['runtime']) return p['runtime']
  }
  return 'Agente'
}

export const painelRoutes = async (
  app: FastifyInstance,
  opts: PainelRoutesOpts = {}
): Promise<void> => {
  const lerCotas = opts.lerCotas ?? (async () => [] as MotorCota[])
  const answer =
    opts.answerImpl ??
    ((id: string, valor: string, via: 'telegram' | 'panel') => {
      // Decorado SEMPRE pelo telegramPlugin (mesmo sem bot token, mesmo em
      // teste) — é a MESMA instância que o Telegram usa, com Cortex ligado.
      const svc = app.agentQuestionService
      if (!svc) throw new Error('agentQuestionService não registrado (telegramPlugin ausente)')
      return svc.answer(id, valor, via)
    })

  const isoOuNulo = (d: Date | string | null | undefined): string | null =>
    d == null ? null : d instanceof Date ? d.toISOString() : d

  // GET /api/v1/painel/pulso — o último sinal de qualquer projeto do dono, com
  // a hora REAL do evento. (API.md §2.2: /api/projects/:id/status devolve
  // lastActivity = new Date() — a hora da consulta, não a do evento; ligado ao
  // pulso isso diria "há 0 segundos" para sempre. Aqui usamos o createdAt real.)
  app.get(
    '/api/v1/painel/pulso',
    RATE_LIMIT_POLLING,
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)

      const [evento, missao] = await Promise.all([
        app.prisma.event.findFirst({
          where: { project: { userId: ownerId } },
          orderBy: { createdAt: 'desc' },
          select: { type: true, payload: true, createdAt: true },
        }),
        app.prisma.mission.findFirst({
          where: { project: { userId: ownerId } },
          orderBy: { createdAt: 'desc' },
          select: { type: true, payload: true, createdAt: true, startedAt: true },
        }),
      ])

      const candidatos: { tipo: string; payload: unknown; quando: Date }[] = []
      if (evento)
        candidatos.push({ tipo: evento.type, payload: evento.payload, quando: evento.createdAt })
      if (missao) {
        candidatos.push({
          tipo: missao.type,
          payload: missao.payload,
          quando: missao.startedAt ?? missao.createdAt,
        })
      }

      if (candidatos.length === 0) {
        return reply.send({
          ultimo_sinal_em: null,
          ha_segundos: null,
          descricao: null,
          quente: false,
          limite_frio_segundos: LIMITE_FRIO_SEGUNDOS,
        })
      }

      const sinal = candidatos.reduce((a, b) => (b.quando > a.quando ? b : a))
      const haSegundos = Math.max(0, Math.floor((Date.now() - sinal.quando.getTime()) / 1000))

      return reply.send({
        ultimo_sinal_em: sinal.quando.toISOString(),
        ha_segundos: haSegundos,
        descricao: descreverEvento({ tipo: sinal.tipo, payload: sinal.payload }),
        quente: haSegundos < LIMITE_FRIO_SEGUNDOS,
        limite_frio_segundos: LIMITE_FRIO_SEGUNDOS,
      })
    }
  )

  // GET /api/v1/painel/agentes — quem está atuando agora + a cota de cada motor
  // (API.md §2.3). `atuando` sai das missões em execução do dono. `progresso` é
  // SEMPRE null nesta leva: não há progresso real e medido, e uma barra
  // estimada é pior que barra nenhuma. `motores` é best-effort (ver lerCotas).
  app.get(
    '/api/v1/painel/agentes',
    RATE_LIMIT_POLLING,
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)

      const missoes = await app.prisma.mission.findMany({
        where: { project: { userId: ownerId }, status: { in: ['running', 'pending'] } },
        orderBy: { startedAt: 'desc' },
        take: 12,
        select: {
          id: true,
          type: true,
          payload: true,
          status: true,
          waitingStatus: true,
          startedAt: true,
          createdAt: true,
          project: { select: { name: true } },
        },
      })

      const atuando = missoes.map((m) => ({
        id: m.id,
        nome: nomeDoMotor(m.payload),
        papel: papelDoAgente(m.type),
        estado: estadoDoAgente({ status: m.status, waitingStatus: m.waitingStatus }),
        descricao: descreverEvento({ tipo: m.type, payload: m.payload }),
        projeto: m.project?.name ?? null,
        desde: (m.startedAt ?? m.createdAt).toISOString(),
        progresso: null,
      }))

      let motores: MotorCota[] = []
      try {
        motores = await lerCotas(ownerId)
      } catch (err) {
        // Best-effort: sem cota, a tela mostra "Nenhum motor conectado ainda."
        // em vez de um número inventado. Loga a causa, nunca o conteúdo.
        app.log.warn(
          `[painel/agentes] leitura de cota falhou (best-effort): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        motores = []
      }

      return reply.send({ atuando, motores })
    }
  )

  // POST /api/v1/painel/decisoes/:id/responder — responder uma decisão PELO
  // PAINEL (API.md §2.4). Você escolheu responder nos DOIS lugares; o schema
  // já tinha `answeredVia` porque duas portas eram previstas. O trabalho é a
  // rota — `answer()` (o mesmo que o Telegram usa) aplica a config, grava no
  // Cortex e é idempotente. Paridade painel↔Telegram é este `answer(...,'panel')`.
  app.post<{ Params: { id: string }; Body: { resposta?: string } }>(
    '/api/v1/painel/decisoes/:id/responder',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const { id } = request.params
      const resposta = (request.body?.resposta ?? '').trim()
      if (!resposta) return reply.code(400).send({ error: 'Escreva a resposta.' })

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const pergunta = await app.prisma.agentQuestion.findUnique({ where: { id } })

      // Inexistente e "de outra conta" devolvem a MESMA frase — a resposta não
      // revela que a pergunta existe para outro dono (anti-vazamento).
      if (!pergunta || pergunta.userId !== ownerId) {
        return reply.code(404).send({ error: 'Decisão não encontrada.' })
      }

      // Já respondida (ex.: pelo Telegram): devolve a resposta que existe para a
      // tela mostrar, em vez de sumir com o clique.
      if (pergunta.status === 'answered') {
        return reply.code(409).send({
          code: 'JA_RESPONDIDA',
          answer: pergunta.answer,
          answeredVia: pergunta.answeredVia,
          answeredAt: isoOuNulo(pergunta.answeredAt),
        })
      }

      const atualizada = await answer(id, resposta, 'panel')
      if (!atualizada) {
        // Corrida rara: sumiu entre o findUnique e o answer.
        return reply.code(404).send({ error: 'Decisão não encontrada.' })
      }

      // Nunca vaza userId, dedupKey, telegramMessageId nem projectId.
      return reply.send({
        id: atualizada.id,
        status: 'answered',
        answer: atualizada.answer,
        answeredAt: isoOuNulo(atualizada.answeredAt),
        answeredVia: atualizada.answeredVia,
      })
    }
  )
}
