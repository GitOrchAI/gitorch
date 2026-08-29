import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveOwnerId } from '../lib/resolve-owner-id.js'
import { descreverEvento, papelDoAgente, estadoDoAgente } from '../services/descrever-evento.js'
import type { AgentQuestionRecord } from '../services/agent-question.js'
import {
  lerArvoreDePedidos,
  projetoDaLinha,
  ArvoreIndisponivelError,
  type PedidoDoPainel,
  type ProjetoDoDono,
} from '../services/arvore-de-pedidos.js'
import { sprintCorrente, type Iteracao, hojeNoFuso } from '../services/garantir-sprint.js'
import {
  lerRepositorios,
  LeituraIndisponivelError,
  type LeituraDeProjeto,
} from '../services/leitura-do-repositorio.js'

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
  /**
   * Lê a árvore dos pedidos no GitHub. Default: o serviço real, com os
   * projetos do dono e a credencial dele. Injetável só nos testes.
   */
  lerPedidos?: (args: {
    ownerId: string
    projeto?: string | undefined
  }) => Promise<PedidoDoPainel[]>
  /**
   * Lê as sprints configuradas nos quadros do dono. Default: ainda não há
   * caminho ligado (o quadro do cliente é configurado no passo de execução do
   * bloco 3), então devolve lista vazia e a tela diz honestamente que não há
   * sprint — nunca inventa uma. Injetável nos testes.
   */
  lerSprints?: (args: {
    ownerId: string
    projeto?: string | undefined
  }) => Promise<Array<{ projeto: string; iteracoes: Iteracao[] }>>
  /**
   * Lê o que existe nos repositórios do dono. Default: o serviço real, com a
   * credencial dele. Injetável só nos testes.
   */
  lerLeituras?: (args: {
    ownerId: string
    projeto?: string | undefined
  }) => Promise<LeituraDeProjeto[]>
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

  const lerPedidos =
    opts.lerPedidos ??
    ((args: { ownerId: string; projeto?: string | undefined }) =>
      lerArvoreDePedidos(
        {
          // `projetoDaLinha` carrega a regra de qual campo é o endereço do
          // repositório — e o porquê. Ela é testada; este default só a aplica.
          listarProjetos: async (ownerId: string): Promise<ProjetoDoDono[]> => {
            const ps = await app.prisma.project.findMany({
              where: { userId: ownerId, isActive: true },
              select: { name: true, wingId: true },
            })
            return ps.map(projetoDaLinha)
          },
          // A credencial do DONO, não a da instalação: os pedidos vivem no
          // repositório dele, e é a permissão dele que vale.
          lerToken: async (ownerId: string) =>
            (await app.engineConnections?.getRawGithubToken(ownerId)) ?? null,
        },
        args
      ))

  // Sem caminho ligado ainda: o quadro do cliente só ganha sprint no passo de
  // execução do bloco 3. Lista vazia faz a tela dizer que não há sprint
  // configurada — que é a verdade — em vez de desenhar uma semana inventada.
  const lerSprints = opts.lerSprints ?? (async () => [])

  // Os repositórios do dono, do mesmo jeito que a árvore de pedidos os lê —
  // `projetoDaLinha` carrega a regra de qual campo é o ENDEREÇO do repositório
  // (o par name/wingId já custou um 503 em produção). Nome diferente do
  // `projetosDoDono` logo abaixo de propósito: aquele devolve ids, para
  // filtrar consulta de banco; este devolve endereços, para falar com o
  // GitHub. Dois nomes iguais para coisas diferentes é como se troca um pelo
  // outro sem perceber.
  const repositoriosDoDono = async (ownerId: string): Promise<ProjetoDoDono[]> => {
    const ps = await app.prisma.project.findMany({
      where: { userId: ownerId, isActive: true },
      select: { name: true, wingId: true },
    })
    return ps.map(projetoDaLinha)
  }

  const lerLeituras =
    opts.lerLeituras ??
    ((args: { ownerId: string; projeto?: string | undefined }) =>
      lerRepositorios(
        {
          listarProjetos: repositoriosDoDono,
          // A credencial do DONO: o repositório é dele, e é a permissão dele
          // que decide o que dá para ver.
          lerToken: async (ownerId: string) =>
            (await app.engineConnections?.getRawGithubToken(ownerId)) ?? null,
        },
        args
      ))

  const isoOuNulo = (d: Date | string | null | undefined): string | null =>
    d == null ? null : d instanceof Date ? d.toISOString() : d

  /** Ids dos projetos do dono — filtrar por `projectId: { in }` usa o índice
   *  `[projectId, createdAt]` de Event/Mission; `where: { project: { userId } }`
   *  força um semi-join + sort sem índice utilizável no caminho quente do pulso. */
  const projetosDoDono = async (ownerId: string): Promise<string[]> => {
    const ps = await app.prisma.project.findMany({
      where: { userId: ownerId },
      select: { id: true },
    })
    return ps.map((p) => p.id)
  }

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
      const ids = await projetosDoDono(ownerId)
      if (ids.length === 0) {
        return reply.send({
          ultimo_sinal_em: null,
          ha_segundos: null,
          descricao: null,
          quente: false,
          limite_frio_segundos: LIMITE_FRIO_SEGUNDOS,
        })
      }

      const [evento, missao] = await Promise.all([
        app.prisma.event.findFirst({
          where: { projectId: { in: ids } },
          orderBy: { createdAt: 'desc' },
          select: { type: true, payload: true, createdAt: true },
        }),
        app.prisma.mission.findFirst({
          where: { projectId: { in: ids } },
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
      const ids = await projetosDoDono(ownerId)

      const missoes = ids.length
        ? await app.prisma.mission.findMany({
            where: { projectId: { in: ids }, status: { in: ['running', 'pending'] } },
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
        : []

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

  // GET /api/v1/painel/pedidos — os desejos do dono, com a árvore que o
  // Produto pendurou embaixo de cada um.
  //
  // Nada aqui é inventado: o desejo é a issue com a etiqueta `wishlist`
  // (services/desejo.ts) e o andamento vem de `subIssuesSummary`, que o
  // próprio GitHub calcula. Consulta disparada de verdade antes de existir
  // esta rota (29/08): 5 pedidos, um em 1 de 3 partes, outro em 0 de 0.
  //
  // `?projeto=` filtra por um projeto; sem ele vêm os de TODOS — o painel é
  // multi-projeto por natureza, porque o cliente tem de 1 a 10 repositórios
  // conosco e o executivo precisa ver como flui cada um.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/pedidos',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim() || undefined
      try {
        const pedidos = await lerPedidos({ ownerId, projeto })
        return reply.send({ pedidos })
      } catch (err) {
        if (err instanceof ArvoreIndisponivelError) {
          // 503 e não 500: a tela distingue "não consegui ler agora" de "você
          // não pediu nada". Devolver lista vazia aqui seria mentir.
          app.log.warn(`[painel/pedidos] árvore indisponível: ${err.message}`)
          return reply.code(503).send({ error: 'PEDIDOS_INDISPONIVEIS' })
        }
        throw err
      }
    }
  )

  // GET /api/v1/painel/leitura — o que o GitOrch enxerga em cada repositório.
  //
  // Resposta à pergunta do dono: "o cliente acabou de por repositório no
  // gitorch, o gitorch começa a ler sobre — como vai ser feito esse
  // pensamento?" Esta rota CONTA o que está lá; não julga, não dá nota, não
  // estima. Cada número vem da API do GitHub ou não aparece.
  //
  // Um repositório que não responde entra na lista como indisponível, com o
  // motivo em português — nunca como zero, que faria o dono achar que ele está
  // vazio. Só quando NENHUM responde a rota devolve 503.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/leitura',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim() || undefined
      try {
        const leituras = await lerLeituras({ ownerId, projeto })
        return reply.send({
          leituras,
          // Separa "li e não achei nada" de "não consegui ler". A tela precisa
          // dos dois para não dizer a frase errada.
          lidos: leituras.filter((l) => l.disponivel).length,
        })
      } catch (err) {
        if (err instanceof LeituraIndisponivelError) {
          app.log.warn(`[painel/leitura] leitura indisponível: ${err.message}`)
          return reply.code(503).send({ error: 'LEITURA_INDISPONIVEL' })
        }
        throw err
      }
    }
  )

  // GET /api/v1/painel/sprint — a sprint que está valendo AGORA.
  //
  // Substitui o "ritmo da semana" do desenho original: o dono trocou semana
  // por sprint ("quais sprints estão atuais e o que está atuando"), e a sprint
  // do GitOrch é o campo de iteração do quadro do cliente.
  //
  // O GitHub entrega a lista de ciclos e NÃO marca qual está correndo — a
  // conta é nossa (services/garantir-sprint.ts, `sprintCorrente`). Dia fora de
  // qualquer ciclo devolve nada, porque é o intervalo entre sprints e dizer
  // que alguma corre ali seria inventar.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/sprint',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim() || undefined
      const hoje = hojeNoFuso()

      const quadros = await lerSprints({ ownerId, projeto })
      const sprints = quadros
        .map((q) => {
          const atual = sprintCorrente(q.iteracoes, hoje)
          if (!atual) return null
          const fim = new Date(
            new Date(`${atual.startDate}T00:00:00Z`).getTime() + atual.duration * 86400000
          )
          return {
            projeto: q.projeto,
            titulo: atual.title,
            inicio: atual.startDate,
            // Fim EXCLUSIVO vira o último dia do ciclo, que é o que o dono lê.
            fim: new Date(fim.getTime() - 86400000).toISOString().slice(0, 10),
            dias: atual.duration,
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)

      // `configurados` separa "nenhum quadro tem sprint" de "tem sprint mas
      // hoje está no intervalo entre dois ciclos" — duas coisas diferentes que
      // a tela precisa dizer de jeitos diferentes.
      return reply.send({ sprints, configurados: quadros.length })
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
