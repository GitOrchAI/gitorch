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
import {
  sprintCorrente,
  hojeNoFuso,
  CAMPO_DE_SPRINT,
  type Iteracao,
} from '../services/garantir-sprint.js'
import { decidirQuadro } from '../services/resolver-quadro.js'
import { lerCotasDosMotores, type MotorCota } from '../services/cotas-dos-motores.js'
import {
  lerRepositorios,
  LeituraIndisponivelError,
  type LeituraDeProjeto,
} from '../services/leitura-do-repositorio.js'
import { paraTela, type EntregaDoPainel } from '../services/incremento.js'
import { medirCiclo } from '../services/medicao-do-ciclo.js'
import { aplicarOrdemDosPedidos } from '../services/ordem-dos-pedidos.js'
import { exigirPermissao } from '@gitorch/cadence'
import { ProjectV2Client } from '@gitorch/github-sync'
import { fetchDoRepositorio, fetchSemPermissao } from '../services/guarda-de-autonomia.js'
import {
  avaliarPronto,
  normalizarRegua,
  CRITERIOS_DE_PRONTO,
  O_QUE_O_CRITERIO_EXIGE,
  REGUA_PADRAO,
} from '@gitorch/cadence'
import type { PoliticaDePerguntasAoDono } from '../services/duvida-do-dev.js'

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

/**
 * Injeções opcionais (testes). Em produção os defaults são usados.
 *
 * `lerCotas`: leitura das cotas dos motores do dono. O default LÊ O BANCO —
 * e isso é uma correção de 30/08/2026, não um detalhe. Antes o default era
 * `async () => []`, com o comentário (então verdadeiro) de que a cota não era
 * gravada em lugar nenhum. O PR #381 passou a gravá-la pelo relógio e ninguém
 * voltou aqui: como `painelRoutes(app)` é registrada sem opts, a rota caía no
 * default e o painel dizia "Nenhum motor conectado ainda." com o banco cheio
 * (antigravity 56%, claude 27%, lidos no mesmo dia).
 *
 * A lição, que vale além deste arquivo: um default que devolve VAZIO é tão
 * perigoso quanto um que devolve credencial crua — vazio é um estado plausível,
 * então a mentira passa por comportamento normal. É a mesma família do
 * `options.fetchImpl ?? fetch` que o bloco 4 trocou por `fetchSemPermissao()`.
 * Aqui o conserto é o simétrico: o default faz a COISA CERTA, e quem quiser
 * outro comportamento injeta de propósito.
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
  const lerCotas = opts.lerCotas ?? ((ownerId: string) => lerCotasDosMotores(app.prisma, ownerId))
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

  // A sprint LIDA DE VERDADE do quadro de cada projeto.
  //
  // Isto ficou como lista vazia desde o bloco 3, e a tela do dono dizia "ainda
  // não têm sprint configurada" para sempre — uma funcionalidade inteira parada
  // a um fio de ser ligada.
  //
  // SÓ LEITURA. Criar ou configurar a sprint escreve no quadro do cliente e
  // passa pela guarda de autonomia; continua fora daqui de propósito.
  //
  // Um projeto que falha não derruba os outros — mesmo padrão da árvore de
  // pedidos. Um quadro sem campo de iteração devolve zero ciclos, e a tela diz
  // honestamente que não há sprint.
  const lerSprints =
    opts.lerSprints ??
    (async (args: { ownerId: string; projeto?: string | undefined }) => {
      const todos = await repositoriosDoDono(args.ownerId)
      const projetos = args.projeto ? todos.filter((p) => p.nome === args.projeto) : todos
      if (projetos.length === 0) return []

      const token = (await app.engineConnections?.getRawGithubToken(args.ownerId)) ?? null
      if (!token) return []

      const cliente = new ProjectV2Client({
        token,
        // Leitura passa em qualquer nível; o embrulho está aqui porque é a
        // porta única, não porque esta chamada precise de permissão.
        fetchImpl: fetchSemPermissao(),
      })

      const saida: Array<{ projeto: string; iteracoes: Iteracao[] }> = []
      for (const projeto of projetos) {
        try {
          const quadros = await cliente.listarQuadrosDoRepositorio(partirEndereco(projeto.repo))
          // `repository.projectsV2` só traz quadros ANUNCIADOS naquele
          // repositório — então `linkado` é verdadeiro por construção, e dizer
          // isso aqui é mais honesto que deixar o campo faltando e a decisão
          // achar que nenhum está ligado.
          const decisao = decidirQuadro({
            candidatos: quadros.map((q) => ({ ...q, linkado: true })),
          })
          // Só o caso 'usar' tem um quadro certo. 'criar', 'escolher' e
          // 'sem_acesso' são respostas legítimas que NÃO dão uma sprint — e
          // inventar uma aqui seria pior que não mostrar nenhuma.
          if (decisao.acao !== 'usar') continue

          const campo = await cliente.getIterationField({
            projectId: decisao.quadro.id,
            fieldName: CAMPO_DE_SPRINT,
          })
          saida.push({ projeto: projeto.nome, iteracoes: campo.iterations })
        } catch (err) {
          // Quadro sem campo de sprint é o caminho NORMAL de quem nunca
          // configurou, não um erro — e qualquer outra falha também não pode
          // derrubar os outros projetos.
          app.log.debug(`[painel/sprint] ${projeto.repo}: ${String(err).slice(0, 120)}`)
        }
      }
      return saida
    })

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

      // Três estados, não dois. "Não consegui ler a cota" e "este dono não tem
      // motor nenhum" davam a MESMA tela vazia, e é assim que uma falha vira
      // silêncio: o dono lê "nenhum motor conectado" e acredita. `cotaLida`
      // separa os dois — lista vazia com `cotaLida: true` é um fato; com
      // `false`, é o produto dizendo que não sabe, e por quê.
      let motores: MotorCota[] = []
      let cotaLida = true
      let motivoDaCota: string | null = null
      try {
        motores = await lerCotas(ownerId)
      } catch (err) {
        cotaLida = false
        motivoDaCota = 'não consegui ler a cota dos seus motores agora'
        // Loga a causa técnica; a resposta leva só a frase de negócio.
        app.log.warn(
          `[painel/agentes] leitura de cota falhou: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        motores = []
      }

      return reply.send({ atuando, motores, cotaLida, motivoDaCota })
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

  // POST /api/v1/painel/duvida-config — ESTEIRA-T14. Grava quanto o dono quer
  // ver no chat sobre dúvidas do dev assíncrono NESTE projeto
  // (runtimeConfig.perguntasAoDono). Sem GET dedicado: `GET /api/projects`
  // (ROTAS.repos) já devolve `runtimeConfig` por projeto — criar uma segunda
  // rota só para ler o mesmo dado seria duplicar, não servir.
  //
  // Por `projectId` (o cuid interno), não por `wingId`: a lista de /api/projects
  // devolve `id` de verdade, e `name` ali NÃO é o endereço do repositório — foi
  // exatamente essa confusão que escondia projetos do dono até o PR #367.
  // Nunca sobrescreve o resto do runtimeConfig (board.columns,
  // board.sprintDays...): lê o que já existe e faz merge de UMA chave.
  app.post<{ Body: { projectId?: string; perguntasAoDono?: string } }>(
    '/api/v1/painel/duvida-config',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const projectId = request.body?.projectId?.trim()
      if (!projectId) return reply.code(400).send({ error: 'Informe o projeto.' })
      const valores: PoliticaDePerguntasAoDono[] = [
        'so-executivo',
        'executivo-e-tecnico-bloqueante',
        'tudo',
      ]
      const politica = request.body?.perguntasAoDono
      if (!valores.includes(politica as PoliticaDePerguntasAoDono)) {
        return reply
          .code(400)
          .send({ error: `perguntasAoDono precisa ser um de: ${valores.join(', ')}` })
      }

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const row = await app.prisma.project.findFirst({
        where: { id: projectId, userId: ownerId },
        select: { id: true, runtimeConfig: true },
      })
      // Inexistente e "de outro dono" devolvem a MESMA frase — mesmo
      // anti-vazamento de /decisoes/:id/responder.
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      const configAtual = (row.runtimeConfig as Record<string, unknown> | null) ?? {}
      await app.prisma.project.update({
        where: { id: row.id },
        data: { runtimeConfig: { ...configAtual, perguntasAoDono: politica } },
      })

      return reply.send({ perguntasAoDono: politica })
    }
  )

  // GET /api/v1/painel/timeline — ESTEIRA-T15. Os últimos 10 eventos de
  // AUDITORIA/PROGRESSO ("N entregas barradas", "issue voltou pra fila"...)
  // que antes viravam spam no Telegram (rajada real de 29/08: 4 mensagens em
  // 5 minutos, nenhuma decisão pra tomar). Não somem — mudam de canal.
  app.get(
    '/api/v1/painel/timeline',
    RATE_LIMIT_POLLING,
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const ids = await projetosDoDono(ownerId)
      if (ids.length === 0) return reply.send({ eventos: [] })

      const eventos = await app.prisma.event.findMany({
        where: { projectId: { in: ids }, type: 'audit' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { payload: true, createdAt: true },
      })

      return reply.send({
        eventos: eventos.map((e) => ({
          texto: textoDoEventoDeAuditoria(e.payload),
          quando: e.createdAt.toISOString(),
        })),
      })
    }
  )

  // GET /api/v1/painel/entregas — o que ficou pronto, e o que ainda não.
  //
  // Scrum 2020: o Incremento nasce quando um item atende à Definição de Pronto.
  // A régua é do CLIENTE, e o que falta vem escrito — uma entrega parada sem
  // ninguém dizer por quê é o silêncio que este bloco veio acabar.
  //
  // Os fatos vêm de `dev_sessions`, que o caminho que já roda grava. Nenhum
  // rastreio novo: uma segunda fonte da verdade sobre "isto ficou pronto"
  // divergiria da primeira, e o dono descobriria pelo número errado.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/entregas',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim() || undefined

      const projetos = await app.prisma.project.findMany({
        where: { userId: ownerId, isActive: true, ...(projeto ? { name: projeto } : {}) },
        select: { id: true, name: true, reguaDePronto: true },
      })
      if (projetos.length === 0) return reply.send({ entregas: [], prontas: 0 })

      const porId = new Map(projetos.map((p) => [p.id, p]))
      const sessoes = await app.prisma.devSession.findMany({
        where: { projectId: { in: projetos.map((p) => p.id) } },
        select: {
          projectId: true,
          issueNumber: true,
          pullRequestNumber: true,
          mergeCommitSha: true,
          deployState: true,
          envLastVerdict: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      })

      const entregas: EntregaDoPainel[] = sessoes.map((s) => {
        const proj = porId.get(s.projectId)
        const veredito = avaliarPronto(s, normalizarRegua(proj?.reguaDePronto))
        return paraTela({
          projeto: proj?.name ?? '',
          pedido: s.issueNumber,
          entrega: s.pullRequestNumber,
          veredito,
          // A data só existe quando fechou. Mostrar a última mexida como se
          // fosse a data da entrega diria que ficou pronto num dia em que não
          // ficou.
          prontoEm: veredito.pronto ? s.updatedAt : null,
        })
      })

      return reply.send({ entregas, prontas: entregas.filter((e) => e.pronto).length })
    }
  )

  // GET /api/v1/painel/ciclo — quanto o nosso ciclo custa, contando o retrabalho.
  //
  // O raciocínio do dono: "se o modelo é 20x melhor que humano, mas teve 5
  // retrabalhos, o ganho real não é 20x". A conta desconta o retrabalho.
  //
  // MEDIANA E P90, NUNCA SÓ MÉDIA. Medido no banco dele em 30/08: a média de
  // cutucadas dá 5,0 e a mediana dá 1 — a média está sendo puxada por uma
  // entrega que levou 65. Quem lê a média conclui que tudo é ruim; quem lê as
  // duas vê que o caso típico é tranquilo e a dor está na cauda.
  //
  // E o número é do NOSSO banco. Multiplicador importado de fora ("IA é 10x
  // mais rápida") é marketing de outra empresa, não medição nossa.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/ciclo',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim() || undefined

      const projetos = await app.prisma.project.findMany({
        where: { userId: ownerId, isActive: true, ...(projeto ? { name: projeto } : {}) },
        select: { id: true },
      })
      if (projetos.length === 0) return reply.send(medirCiclo([]))

      const fatos = await app.prisma.devSession.findMany({
        where: { projectId: { in: projetos.map((p) => p.id) } },
        select: {
          attempts: true,
          nudges: true,
          requeueCount: true,
          mergeFailures: true,
          createdAt: true,
          closedAt: true,
        },
      })

      return reply.send(medirCiclo(fatos))
    }
  )

  // POST /api/v1/painel/ordem — o cliente reordena os pedidos, e o QUADRO DELE
  // no GitHub acompanha.
  //
  // Decisão do dono (5.1): "o cliente só vai acessar o nosso painel, ajusta
  // pelo painel e isso ajusta automaticamente nas outras plataformas".
  //
  // É a PRIMEIRA rota do painel que ESCREVE no repositório do cliente, e veio
  // por último de propósito. Passa pela guarda de autonomia antes de mover
  // qualquer coisa, e registra o que fez para ele poder ver depois.
  app.post<{ Body: { projeto?: string; pedidos?: number[] } }>(
    '/api/v1/painel/ordem',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)

      const projeto = request.body?.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      // O painel manda NÚMEROS de pedido — o que o dono reconhece —, nunca ids
      // internos do quadro. A tradução acontece aqui embaixo; expor id de
      // quadro na tela seria vazar encanamento para quem só quer arrastar um
      // card.
      const numeros = (request.body?.pedidos ?? []).filter(
        (n): n is number => typeof n === 'number' && Number.isInteger(n)
      )
      if (numeros.length === 0) {
        return reply.code(400).send({ error: 'Informe os pedidos na ordem que você quer.' })
      }

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { id: true, wingId: true, autonomia: true, runtimeConfig: true },
      })
      // Inexistente e "de outro dono" devolvem a MESMA frase — mesmo
      // anti-vazamento das outras rotas do painel.
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      const quadro = resolveQuadroDoProjeto(row.runtimeConfig)
      if (!quadro) {
        return reply
          .code(409)
          .send({ error: 'Este projeto ainda não tem quadro no GitHub para reordenar.' })
      }

      // A PERMISSÃO É CONFERIDA ANTES DA CREDENCIAL, e a ordem importa.
      //
      // Pedir credencial primeiro fazia um projeto em "só olhar" e sem
      // credencial receber "indisponível" — a mensagem errada. Quem disse que
      // não quer que o produto escreva merece ouvir exatamente isso, e não uma
      // falha de infraestrutura que não tem nada a ver com a decisão dele.
      try {
        exigirPermissao(row.autonomia, 'organizar')
      } catch (err) {
        return reply.code(403).send({ error: (err as Error).message })
      }

      const token = (await app.engineConnections?.getRawGithubToken(ownerId)) ?? null
      if (!token) return reply.code(503).send({ error: 'ORDEM_INDISPONIVEL' })

      try {
        const cliente = new ProjectV2Client({
          token,
          fetchImpl: fetchDoRepositorio({ nivel: () => row.autonomia }),
        })

        // O quadro é guardado como "dono/número"; o GraphQL precisa do id. A
        // resolução acontece aqui, com a mesma credencial e a mesma guarda.
        // O quadro pode estar na ORGANIZAÇÃO ou na conta pessoal, e o produto
        // não guarda qual. Tenta os dois em vez de exigir que o cliente saiba a
        // diferença: para ele é "o meu quadro", não "o quadro da minha org".
        const quadroId =
          (await cliente.findProjectId({
            login: quadro.login,
            number: quadro.numero,
            ownerType: 'organization',
          })) ??
          (await cliente.findProjectId({
            login: quadro.login,
            number: quadro.numero,
            ownerType: 'user',
          }))
        if (!quadroId) {
          return reply
            .code(409)
            .send({ error: 'Não encontrei o seu quadro no GitHub para reordenar.' })
        }

        // Traduz número de pedido para item do quadro. Um número que NÃO está
        // no quadro é descartado com aviso, e não inventa item: mover algo que
        // não existe ali daria erro do GitHub no meio da fila, deixando a
        // ordem pela metade.
        const itens = await cliente.listarItensDoQuadro(quadroId)
        const porNumero = new Map(itens.map((i) => [i.pedido, i.itemId]))
        const pedidos = numeros
          .filter((n) => porNumero.has(n))
          .map((n) => ({ pedido: n, itemId: porNumero.get(n)! }))
        const foraDoQuadro = numeros.filter((n) => !porNumero.has(n))

        if (pedidos.length === 0) {
          return reply
            .code(409)
            .send({ error: 'Nenhum desses pedidos está no seu quadro para ser reordenado.' })
        }

        const registro = await aplicarOrdemDosPedidos(
          {
            quadro: cliente,
            nivel: () => row.autonomia,
            registrar: async (r) => {
              await app.prisma.event.create({
                data: {
                  projectId: row.id,
                  type: 'painel_escreveu',
                  payload: { texto: r.oQueFiz, ordem: r.ordem, quando: r.quando },
                },
              })
            },
          },
          { projectId: quadroId, pedidos }
        )
        // O que ficou de fora vai DITO na resposta. Aplicar cinco de sete e
        // responder "pronto" faria o dono achar que a ordem inteira valeu.
        return reply.send({ ...registro, foraDoQuadro })
      } catch (err) {
        // A recusa da autonomia NÃO é erro do produto: é a escolha do cliente
        // valendo. Vira 403 com o motivo que a própria regra escreveu, para a
        // tela poder dizer o que fazer.
        if ((err as Error)?.name === 'EscritaNaoAutorizadaError') {
          return reply.code(403).send({ error: (err as Error).message })
        }
        app.log.error(err, `[painel/ordem] não consegui reordenar ${row.wingId}`)
        return reply.code(502).send({ error: 'Não consegui falar com o GitHub agora.' })
      }
    }
  )

  // GET /api/v1/painel/regua — a régua deste projeto, e o que cada critério exige.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/regua',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { reguaDePronto: true, reguaEscolhidaEm: true },
      })
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      return reply.send({
        regua: normalizarRegua(row.reguaDePronto),
        // Separa "ele escolheu isto" de "está no padrão porque ninguém
        // escolheu" — sem isso a tela afirmaria uma decisão que não houve.
        escolhida: row.reguaEscolhidaEm !== null,
        criterios: CRITERIOS_DE_PRONTO.map((c) => ({ chave: c, exige: O_QUE_O_CRITERIO_EXIGE[c] })),
        padrao: REGUA_PADRAO,
      })
    }
  )

  // POST /api/v1/painel/regua — o cliente muda a régua.
  app.post<{ Body: { projeto?: string; regua?: Record<string, unknown> } }>(
    '/api/v1/painel/regua',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const projeto = request.body?.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { id: true },
      })
      // Inexistente e "de outro dono" devolvem a MESMA frase — mesmo
      // anti-vazamento das outras rotas do painel.
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      // Normaliza na porta: chave desconhecida é descartada e valor que não é
      // booleano é ignorado. O que o produto não reconhece nunca vira régua.
      const regua = normalizarRegua(request.body?.regua)

      await app.prisma.project.update({
        where: { id: row.id },
        data: { reguaDePronto: regua, reguaEscolhidaEm: new Date() },
      })

      return reply.send({ regua, escolhida: true })
    }
  )
}

/**
 * O quadro deste projeto, do jeito que o produto REALMENTE o guarda.
 *
 * Eu tinha escrito isto procurando um `githubBoardId` — uma chave que o produto
 * nunca gravou. Conferido no banco do dono: o que existe é
 * `envConfig.GITORCH_PROJECT_BOARD` no formato "dono/número" (ex.:
 * "GitOrchAI/2"), que é exatamente o que `resolveRailsBoard` já lê no
 * scheduler. Inventar uma chave nova faria a rota responder "você não tem
 * quadro" para quem tem.
 *
 * `null` quando não há: reordenar um quadro que não existe não é erro do
 * cliente, é um passo que ainda não aconteceu — e a rota diz isso.
 */
export function resolveQuadroDoProjeto(
  runtimeConfig: unknown
): { login: string; numero: number } | null {
  if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig)) {
    return null
  }
  const env = (runtimeConfig as Record<string, unknown>)['envConfig']
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null
  const bruto = (env as Record<string, unknown>)['GITORCH_PROJECT_BOARD']
  if (typeof bruto !== 'string') return null

  const [login, numeroTexto, ...resto] = bruto.split('/')
  if (!login || !numeroTexto || resto.length > 0) return null
  const numero = Number(numeroTexto)
  return Number.isInteger(numero) && numero > 0 ? { login, numero } : null
}

/** "dono/repo" nas duas metades que a API do GitHub pede. */
function partirEndereco(repo: string): { owner: string; repo: string } {
  const [owner, nome] = repo.split('/')
  return { owner: owner ?? '', repo: nome ?? '' }
}

/** Payload sem `texto` é evento antigo/inesperado — nunca inventa conteúdo. */
function textoDoEventoDeAuditoria(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { texto?: unknown }).texto === 'string'
  ) {
    return (payload as { texto: string }).texto
  }
  return ''
}
