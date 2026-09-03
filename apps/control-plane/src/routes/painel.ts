import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveOwnerId } from '../lib/resolve-owner-id.js'
import { descreverEvento, papelDoAgente, estadoDoAgente } from '../services/descrever-evento.js'
import type { AgentQuestionRecord } from '../services/agent-question.js'
import {
  lerArvoreDePedidos,
  lerArvoreDoPedido,
  projetoDaLinha,
  ArvoreIndisponivelError,
  PedidoNaoEncontradoError,
  type PedidoDoPainel,
  type ProjetoDoDono,
  type NoDaArvore,
} from '../services/arvore-de-pedidos.js'
import {
  sprintCorrente,
  hojeNoFuso,
  CAMPO_DE_SPRINT,
  DIAS_DE_SPRINT_PADRAO,
  MINIMO_DE_DIAS_DA_SPRINT,
  MAXIMO_DE_DIAS_DA_SPRINT,
  type Iteracao,
} from '../services/garantir-sprint.js'
import { decidirQuadro } from '../services/resolver-quadro.js'
import { lerCredencialDoProjeto } from '../services/project-credential.js'
import { lerCotasDosMotores, type MotorCota } from '../services/cotas-dos-motores.js'
import { resumoDeCotaDoDev } from '../services/resumo-de-cota-do-dev.js'
import {
  lerRepositorios,
  LeituraIndisponivelError,
  type LeituraDeProjeto,
} from '../services/leitura-do-repositorio.js'
import {
  julgarPedidos,
  paginar,
  inteiroDaQuery,
  grupoDaQuery,
} from '../services/entregas-por-pedido.js'
import {
  medirCiclo,
  medirMultiplicador,
  type FatosDoCicloDoItem,
} from '../services/medicao-do-ciclo.js'
import { aplicarOrdemDosPedidos } from '../services/ordem-dos-pedidos.js'
import { exigirPermissao } from '@gitorch/cadence'
import { ProjectV2Client } from '@gitorch/github-sync'
import { fetchDoRepositorio, fetchSemPermissao } from '../services/guarda-de-autonomia.js'
import {
  normalizarRegua,
  CRITERIOS_DE_PRONTO,
  O_QUE_O_CRITERIO_EXIGE,
  REGUA_PADRAO,
} from '@gitorch/cadence'
import type { PoliticaDePerguntasAoDono } from '../services/duvida-do-dev.js'

// Rotas do painel do owner (ui_kits/painel-owner/API.md do handoff GitOrch
// Design System). Nesta leva: pulso, agentes e responder-decisão ao vivo.
// `entregas` está AO VIVO desde a leva 2 — este comentário dizia que ela
// "fica para a leva 2", e um comentário desatualizado ao lado de uma rota que
// responde é da mesma família do contrato fantasma que a tela carregava.
// Continuam sem rota: `ritmo` e `historico`.
//
// Escopo por DONO resolvido por e-mail (mesma regra de routes/setup.ts — o
// helper compartilhado lib/resolve-owner-id.ts). Nenhuma resposta carrega
// userId, dedupKey, telegramMessageId ou o id do projeto.

const RATE_LIMIT_POLLING = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
const NAO_LOGADO = { error: 'UNAUTHORIZED: session required' }
const LIMITE_FRIO_SEGUNDOS = 3600

// Paginação das entregas. O teto que saiu do meio da consulta — onde escondia
// entregas prontas — volta aqui, onde limita só o TAMANHO DA PÁGINA e nunca a
// população que os números do cabeçalho contam.
const ENTREGAS_POR_PAGINA = 25
const ENTREGAS_POR_PAGINA_MAX = 100

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
   * Lê a árvore de UM pedido — fase→épico→feature→task. Default: o serviço
   * real. Chamada só quando o dono expande a linha na tela (D2, leva 3):
   * pendurar a árvore de TODOS os pedidos da lista estouraria o teto de nós
   * do GraphQL do GitHub muito antes de chegar em qualquer fase. Injetável
   * só nos testes.
   */
  lerArvoreDoPedido?: (args: {
    ownerId: string
    projeto: string
    numero: number
  }) => Promise<NoDaArvore[]>
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

  const lerArvoreDeUmPedido =
    opts.lerArvoreDoPedido ??
    ((args: { ownerId: string; projeto: string; numero: number }) =>
      lerArvoreDoPedido(
        {
          listarProjetos: async (ownerId: string): Promise<ProjetoDoDono[]> => {
            const ps = await app.prisma.project.findMany({
              where: { userId: ownerId, isActive: true },
              select: { name: true, wingId: true },
            })
            return ps.map(projetoDaLinha)
          },
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

      const saida: Array<{ projeto: string; iteracoes: Iteracao[] }> = []
      for (const projeto of projetos) {
        // UM cliente POR PROJETO: a credencial que alcança o quadro é dele, não
        // do dono em geral.
        const token = await credencialQueAlcanca(args.ownerId, projeto.id)
        if (!token) continue
        const cliente = new ProjectV2Client({
          token,
          // Leitura passa em qualquer nível; o embrulho está aqui porque é a
          // porta única, não porque esta chamada precise de permissão.
          fetchImpl: fetchSemPermissao(),
        })
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
      // O `id` vem junto porque a credencial que alcança o quadro é POR
      // PROJETO: o aplicativo do produto não enxerga quadro de conta pessoal,
      // e nesses casos vale a que o cliente guardou.
      select: { id: true, name: true, wingId: true },
    })
    return ps.map(projetoDaLinha)
  }

  /**
   * A credencial que ALCANÇA o quadro deste projeto.
   *
   * A do cliente primeiro, a do aplicativo depois — a mesma ordem que o relógio
   * usa para escrever (`varrerSprintDosProjetos`). Sem isto, ler e escrever
   * usavam credenciais diferentes: a escrita criava a sprint no quadro de conta
   * pessoal e a leitura não a enxergava, então o painel dizia que não havia
   * sprint num quadro que acabara de recebê-la.
   */
  const credencialQueAlcanca = async (
    ownerId: string,
    projectId?: string
  ): Promise<string | null> => {
    if (projectId) {
      const doCliente = await lerCredencialDoProjeto({
        prisma: app.prisma as never,
        projectId,
      })
      if (doCliente) return doCliente
    }
    return (await app.engineConnections?.getRawGithubToken(ownerId)) ?? null
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

  // GET /api/v1/painel/dev-cota — a cota do dev assíncrono (Jules), POR CONTA.
  //
  // Pedido do dono (01/09/2026): "precisa saber o que está sendo enviado,
  // quando foi enviado" — ver o consumo, não adivinhar. Até aqui o número só
  // existia DENTRO da decisão de delegar (sm-delegation.ts via
  // montarOpcoesDeDelegacao, scheduler.ts) e nunca saía para o dono ver.
  //
  // JANELA ROLANTE de 24h (não dia de calendário) e teto POR CONTA (não por
  // projeto) — as duas MESMAS regras que já valem para a decisão real de
  // delegar (mesmo motivo do achado de 29/08 em sm-delegation.ts: contar por
  // projeto fez dois projetos "pro" se acharem com 200/dia e 30 simultâneas
  // contra um teto real de 100 e 15). A conta é `project.devAccountId`; nulo
  // agrupa nos projetos que ainda usam a credencial da instância.
  app.get(
    '/api/v1/painel/dev-cota',
    RATE_LIMIT_POLLING,
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)

      const linhasDeProjeto = await app.prisma.project.findMany({
        where: { userId: ownerId },
        select: { id: true, name: true, devPlan: true, devAccountId: true },
      })
      // `nome`, não `name`: o domínio do resumo (e o resto deste arquivo,
      // ver `ProjetoDoDono`/`projetoDaLinha`) fala português; só a coluna do
      // Prisma é inglesa.
      const projetos = linhasDeProjeto.map((p) => ({
        id: p.id,
        nome: p.name,
        devPlan: p.devPlan,
        devAccountId: p.devAccountId,
      }))

      if (projetos.length === 0) {
        return reply.send(resumoDeCotaDoDev({ projetos: [], sessoes: [], agora: new Date() }))
      }

      const corte = new Date(Date.now() - 24 * 60 * 60 * 1000)
      // Uma linha entra se AINDA ocupa vaga (closedAt nulo, de qualquer data —
      // uma sessão pode estar aberta há mais de 24h) OU se foi criada dentro
      // da janela rolante (para a contagem e a lista de enviadas). As duas
      // condições cobrem tudo que o resumo precisa; o resto é ignorado por
      // `resumoDeCotaDoDev` (função pura, sem saber de onde a linha veio).
      const sessoes = await app.prisma.devSession.findMany({
        where: {
          projectId: { in: projetos.map((p) => p.id) },
          OR: [{ closedAt: null }, { createdAt: { gte: corte } }],
        },
        select: {
          projectId: true,
          devAccountId: true,
          issueNumber: true,
          sessionName: true,
          state: true,
          createdAt: true,
          closedAt: true,
        },
      })

      return reply.send(resumoDeCotaDoDev({ projetos, sessoes, agora: new Date() }))
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

  // GET /api/v1/painel/pedidos/arvore — fase→épico→feature→task de UM pedido
  // (D2, leva 3 — "A logica da leva 2", bloco 2, aprovado 30/08).
  //
  // NUNCA junto da lista de pedidos: buscar a árvore inteira dos até 50
  // pedidos da lista de uma vez estouraria o teto de nós do GraphQL do GitHub
  // muito antes de chegar em qualquer fase (ver o comentário de
  // CONSULTA_ARVORE em services/arvore-de-pedidos.ts). Por isso esta rota
  // pede `projeto` E `numero`: o dono expande UMA linha por vez, e a tela
  // busca só aquele pedido.
  app.get<{ Querystring: { projeto?: string; numero?: string } }>(
    '/api/v1/painel/pedidos/arvore',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const projeto = request.query.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const numero = Number(request.query.numero)
      if (!Number.isInteger(numero) || numero <= 0) {
        return reply.code(400).send({ error: 'Informe o número do pedido.' })
      }

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      try {
        const nos = await lerArvoreDeUmPedido({ ownerId, projeto, numero })
        return reply.send({ nos })
      } catch (err) {
        if (err instanceof PedidoNaoEncontradoError) {
          // 404 e não 503: "isto não existe" é diferente de "não consegui
          // ler agora". Mesma frase para projeto errado e número errado —
          // anti-vazamento, igual à rota de ordem.
          app.log.warn(`[painel/pedidos/arvore] ${err.message}`)
          return reply.code(404).send({ error: 'Pedido não encontrado.' })
        }
        if (err instanceof ArvoreIndisponivelError) {
          app.log.warn(`[painel/pedidos/arvore] árvore indisponível: ${err.message}`)
          return reply.code(503).send({ error: 'ARVORE_INDISPONIVEL' })
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

      // L4-T21 — defeito medido em produção (issue #309, 02/09 21:07 UTC):
      // o dono corrigiu a suposição do RA duas vezes e levou HTTP 500 nas
      // duas — `answer()` (via o manipulador `duvida-dev:`,
      // `retomar-sessao-com-resposta.ts`) lançava quando não achava nenhuma
      // sessão viva do dev, e nada aqui tratava a falha. Uma falha do
      // manipulador NUNCA mais vira 500: vira 409 com uma frase em
      // português para o dono (nunca jargão interno — "sessão"/"hash"/
      // "AWAITING"), e a causa REAL vai pro log via `app.log.warn` (nunca
      // escondida — só não é isto que o dono lê).
      let atualizada
      try {
        atualizada = await answer(id, resposta, 'panel')
      } catch (err) {
        const causa = err instanceof Error ? err.message : String(err)
        app.log.warn(`[painel] responder decisão ${id} falhou: ${causa}`)
        return reply.code(409).send({
          error:
            'Não deu para registrar sua resposta agora. Tente de novo em instantes — se continuar ' +
            'falhando, isto já está anotado para investigação.',
        })
      }
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
        // L4-T21: quando o manipulador registrou a ação de forma durável
        // mas não conseguiu entregá-la de imediato (ex.: correção de
        // suposição sem sessão viva do dev), `answer()` devolve este aviso
        // em português (`AgentQuestionRecord.avisoDoManipulador`, EFÊMERO —
        // nunca persistido). Ausente no caminho feliz comum — o corpo
        // continua idêntico a hoje.
        ...(atualizada.avisoDoManipulador ? { aviso: atualizada.avisoDoManipulador } : {}),
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
  //
  // POR QUE NÃO `increments`: a tabela existe e é escrita por scheduler.ts,
  // mas só PARA A FRENTE — em 31/08 ela tem 0 linhas e `dev_sessions` tem 200.
  // Ler dali hoje faria a tela dizer "0 prontas" com quinze entregas no ar. E
  // backfill não resolve, porque `Increment.prontoEm` é `default(now())`:
  // carimbaria 31/08 em entregas que foram ao ar dia 27, inventando
  // retroativamente a data de "ficou pronto".
  //
  // O TETO QUE ESTA ROTA PERDEU: até 31/08 ela trazia as 50 sessões mais
  // recentes. Das 15 entregas prontas do dono, NENHUMA cabia nessas 50 — elas
  // ocupam as posições 66 a 193 na ordem por data. A tela dizia "PRONTAS: 0"
  // com quinze no ar. Agora a rota lê a população inteira do dono, julga por
  // PEDIDO (a unidade do cartão) e pagina só a LISTA.
  //
  // A ORDENAÇÃO PEDE `id` COMO DESEMPATE: `updatedAt` é reescrito pela esteira
  // o tempo todo, e ordenar só por ele deixa linhas empatadas trocando de lugar
  // entre uma leitura e a seguinte.
  app.get<{
    Querystring: { projeto?: string; grupo?: string; pagina?: string; porPagina?: string }
  }>('/api/v1/painel/entregas', RATE_LIMIT_POLLING, async (request, reply) => {
    if (!request.user) return reply.code(401).send(NAO_LOGADO)
    const ownerId = await resolveOwnerId(app.prisma, request.user)
    const projeto = request.query.projeto?.trim() || undefined

    const grupo = grupoDaQuery(request.query.grupo)
    const pagina = inteiroDaQuery(request.query.pagina, 1, 1, Number.MAX_SAFE_INTEGER)
    const porPagina = inteiroDaQuery(
      request.query.porPagina,
      ENTREGAS_POR_PAGINA,
      1,
      ENTREGAS_POR_PAGINA_MAX
    )

    const projetos = await app.prisma.project.findMany({
      where: { userId: ownerId, isActive: true, ...(projeto ? { name: projeto } : {}) },
      select: { id: true, name: true, reguaDePronto: true },
    })
    if (projetos.length === 0) {
      return reply.send({
        entregas: [],
        prontas: 0,
        andando: 0,
        total: 0,
        grupo,
        pagina: 1,
        porPagina,
        paginas: 0,
      })
    }

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
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    })

    const julgados = julgarPedidos(sessoes, projetos)
    const doGrupo = julgados[grupo]

    // `prontas`, `andando` e `total` falam da população INTEIRA, em PEDIDOS —
    // a mesma unidade do cartão, que se chama "Pedido #N". `entregas` é só a
    // página do grupo pedido. Se um dia divergirem, é o número que mente.
    return reply.send({
      entregas: paginar(doGrupo, pagina, porPagina),
      prontas: julgados.prontas.length,
      andando: julgados.andando.length,
      total: julgados.prontas.length + julgados.andando.length,
      grupo,
      pagina,
      porPagina,
      paginas: Math.ceil(doGrupo.length / porPagina),
    })
  })

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
      if (projetos.length === 0)
        return reply.send({ ...medirCiclo([]), multiplicador: medirMultiplicador([]) })

      const projetoIds = projetos.map((p) => p.id)

      const fatos = await app.prisma.devSession.findMany({
        where: { projectId: { in: projetoIds } },
        select: {
          attempts: true,
          nudges: true,
          requeueCount: true,
          mergeFailures: true,
          createdAt: true,
          closedAt: true,
        },
      })

      // D4 — o CICLO DO ITEM (do desejo até a entrega, via Increment/D3),
      // cruzado com o retrabalho da SESSÃO que efetivamente mesclou aquela
      // issue. Isolado do resto: `increments` pode não existir ainda em quem
      // não rodou a migração de D3, ou a consulta pode falhar — o
      // multiplicador cai nos nulos, mas o resto da medição (por sessão, já
      // provado) segue respondendo normalmente.
      let multiplicador = medirMultiplicador([])
      try {
        const incrementos = await app.prisma.increment.findMany({
          where: { projectId: { in: projetoIds } },
          select: { projectId: true, issueNumber: true, wishCreatedAt: true, prontoEm: true },
        })

        if (incrementos.length > 0) {
          const sessoesMescladas = await app.prisma.devSession.findMany({
            where: {
              projectId: { in: projetoIds },
              closedReason: 'merged',
              issueNumber: { in: incrementos.map((i) => i.issueNumber) },
            },
            select: { projectId: true, issueNumber: true, requeueCount: true },
          })
          const retrabalhoPorItem = new Map<string, boolean>()
          for (const s of sessoesMescladas) {
            retrabalhoPorItem.set(`${s.projectId}:${s.issueNumber}`, (s.requeueCount ?? 0) > 0)
          }

          const fatosDoItem: FatosDoCicloDoItem[] = incrementos.map((i) => ({
            wishCreatedAt: i.wishCreatedAt,
            prontoEm: i.prontoEm,
            teveRetrabalho: retrabalhoPorItem.get(`${i.projectId}:${i.issueNumber}`) ?? false,
          }))
          multiplicador = medirMultiplicador(fatosDoItem)
        }
      } catch (err) {
        app.log.warn(err, '[Painel] não consegui medir o multiplicador de velocidade (D4)')
      }

      return reply.send({ ...medirCiclo(fatos), multiplicador })
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
        //
        // O teto de páginas do cliente pode cortar a leitura num quadro
        // enorme. Quando corta, a lista fica incompleta E ESTA ROTA PRECISA
        // SABER: sem isso, um pedido que existe no quadro cai em
        // `foraDoQuadro` e o dono lê "não está no quadro" sobre algo que está.
        // Não pedimos `campoDeSprint`: aqui só se traduz número em item, e
        // pedir o campo de iteração junto seria pagar por um dado que ninguém
        // usa neste caminho.
        let leituraIncompleta = false
        let itensLidos = 0
        const itens = await cliente.listarItensDoQuadro(quadroId, {
          onTruncado: (lidos) => {
            leituraIncompleta = true
            itensLidos = lidos
          },
        })

        // O CORTE É REGISTRADO AQUI, antes de qualquer resposta, e de
        // propósito: o 409 logo abaixo ("nenhum desses pedidos está no seu
        // quadro") é o caminho MAIS mentiroso de todos quando a leitura saiu
        // pela metade. Guardar o aviso só para o fim feliz deixaria o pior
        // caso sem rastro nenhum.
        if (leituraIncompleta) {
          app.log.warn(
            { projectId: row.id, quadro: quadroId, itensLidos },
            `[painel/ordem] leitura do quadro cortada pelo teto em ${row.wingId}`
          )
          // `audit` é o tipo que a timeline do painel LÊ — GET
          // /api/v1/painel/timeline filtra `type: 'audit'` e mostra
          // `payload.texto`. Gravar com outro tipo guardaria o aviso numa
          // gaveta que nenhuma tela abre, que é o mesmo silêncio com um passo
          // a mais.
          await app.prisma.event.create({
            data: {
              projectId: row.id,
              type: 'audit',
              payload: {
                texto:
                  `Ao ajustar a ordem, não consegui ler o seu quadro inteiro: parei em ` +
                  `${itensLidos} itens. A ordem valeu para essa parte, e o que ficou de ` +
                  `fora dela não foi tocado.`,
                itensLidos,
              },
            },
          })
        }

        const porNumero = new Map(itens.map((i) => [i.pedido, i.itemId]))
        const pedidos = numeros
          .filter((n) => porNumero.has(n))
          .map((n) => ({ pedido: n, itemId: porNumero.get(n)! }))
        const foraDoQuadro = numeros.filter((n) => !porNumero.has(n))

        if (pedidos.length === 0) {
          return reply.code(409).send({
            // Duas frases porque são dois fatos diferentes, e o dono decide
            // coisas distintas com cada um: "não está no quadro" pede que ele
            // ponha lá; "não consegui ler tudo" é limitação NOSSA.
            error: leituraIncompleta
              ? `Não achei esses pedidos na parte do quadro que consegui ler (${itensLidos} itens). Seu quadro é grande demais para eu ler de uma vez.`
              : 'Nenhum desses pedidos está no seu quadro para ser reordenado.',
          })
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
        //
        // E `foraDoQuadro` só significa "não está no quadro" quando o quadro
        // foi lido inteiro. Cortado, o certo é "não sei" — por isso o sinal
        // viaja junto, para a tela poder dizer a verdade em vez de acusar o
        // quadro do dono de não ter um pedido que ele tem.
        return reply.send({
          ...registro,
          foraDoQuadro,
          ...(leituraIncompleta ? { leituraIncompleta: true, itensLidos } : {}),
        })
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

  // GET /api/v1/painel/sprint-dias — de quantos dias é a sprint deste projeto.
  //
  // Decisão do dono (30/08/2026): "nosso projeto de desenvolvimento 3 dias mas
  // pra clientes no painel eles decidem de quantos dias". Enquanto a duração era
  // papel, uma constante servia. A partir do momento em que o produto CRIA o
  // campo de iteração no quadro do cliente, o número passa a valer no quadro
  // DELE — e aí não é mais decisão nossa.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/sprint-dias',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { sprintDias: true, sprintDiasEscolhidoEm: true },
      })
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      return reply.send({
        dias: row.sprintDias ?? DIAS_DE_SPRINT_PADRAO,
        // Separa "ele escolheu isto" de "está no padrão porque ninguém
        // escolheu" — mesma distinção da régua e da autonomia.
        escolhido: row.sprintDiasEscolhidoEm !== null,
        padrao: DIAS_DE_SPRINT_PADRAO,
        minimo: MINIMO_DE_DIAS_DA_SPRINT,
        maximo: MAXIMO_DE_DIAS_DA_SPRINT,
      })
    }
  )

  // POST /api/v1/painel/sprint-dias — o cliente escolhe a duração.
  app.post<{ Body: { projeto?: string; dias?: unknown } }>(
    '/api/v1/painel/sprint-dias',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const projeto = request.body?.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      // Validar ANTES de tocar no banco. Uma duração de 0 dias cria um ciclo
      // que nunca fecha e uma de 3650 transforma "sprint" num nome bonito para
      // "sem prazo": as duas quebram a promessa do quadro em vez de
      // configurá-lo. Inteiro, porque o GitHub conta iteração em dias.
      const dias = request.body?.dias
      if (
        typeof dias !== 'number' ||
        !Number.isInteger(dias) ||
        dias < MINIMO_DE_DIAS_DA_SPRINT ||
        dias > MAXIMO_DE_DIAS_DA_SPRINT
      ) {
        return reply.code(400).send({
          error: `A sprint precisa ter de ${MINIMO_DE_DIAS_DA_SPRINT} a ${MAXIMO_DE_DIAS_DA_SPRINT} dias.`,
        })
      }

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { id: true },
      })
      // Inexistente e "de outro dono" devolvem a MESMA frase — mesmo
      // anti-vazamento das outras rotas do painel.
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      await app.prisma.project.update({
        where: { id: row.id },
        data: { sprintDias: dias, sprintDiasEscolhidoEm: new Date() },
      })

      return reply.send({ dias, escolhido: true })
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
