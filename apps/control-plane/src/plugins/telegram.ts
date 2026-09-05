import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import {
  getTelegramUpdates,
  handleTelegramUpdate,
  handleTelegramCallback,
  handleTelegramQuestionReply,
  sendTelegramMessage,
  sendTelegramQuestion,
  tratarPedidoDeDesejo,
  tratarCliqueDeProjeto,
  answerTelegramCallback,
  zerarTecladoDaMensagem,
  type TelegramDesejoDeps,
} from '../services/telegram-bot.js'
import { nascerDesejo } from '../services/nascer-desejo.js'
import { PRAZO_DO_PENDENTE_MS } from '../services/desejo-pendente.js'
import { projetosParaDesejo } from '../services/projetos-do-desejo.js'
import { provaDeEscritaNoUso } from '../services/acesso-ao-repositorio.js'
import {
  resolveNotifyChatId,
  resolveDonoDoChat,
  telegramBotUsername,
} from '../services/telegram-link.js'
import {
  AgentQuestionService,
  type AgentQuestionRecord,
  type ResultadoDoManipuladorDeResposta,
} from '../services/agent-question.js'
import { pipelineCheckEnabled, type PipelineErrorMetadata } from '../config/pipeline-check.js'
import { traduzirErroParaUsuario, type SetupErrorCode } from '../lib/setup-errors.js'
import { processarRespostaDeAutomacao } from '../services/decisao-de-automacao.js'
import { fetchDoRepositorio } from '../services/guarda-de-autonomia.js'
import { lerCredencialQueAlcancaOProjeto } from '../services/project-credential.js'
import {
  aoResponderDuvidaDoDev as retomarSessaoComResposta,
  manipuladorDeResultadoDeRetomada,
  type PrismaParaRetomada,
} from '../services/retomar-sessao-com-resposta.js'
import { criarComentarNaIssue } from '../services/suposicao-imediata-de-duvida.js'
import { decryptCredential } from '../lib/credential-crypto.js'
import {
  aoResponderRetomadaTravada,
  type PrismaParaRetomadaTravada,
} from '../services/responder-retomada-travada.js'
import { chaveDoDevDoProjeto as resolverChaveDoDevDoProjeto } from '../services/chave-do-dev-assincrono.js'
import { criarSessaoJules } from '../services/jules-client.js'
import { abrirSessao, registrarPr, type PrismaDevSession } from '../services/dev-session-store.js'
import { ghJson } from '../services/github-json.js'
import { ProjectV2Client } from '@gitorch/github-sync'
import { resolveQuadroDoProjeto } from '../routes/painel.js'
import { filtrarFilaDeTasks } from '../services/filtrar-fila-de-tasks.js'
import { aplicarOrdemDosPedidos } from '../services/ordem-dos-pedidos.js'
import {
  processarRespostaDeCustoDaOrdem,
  parseDedupKeyDeCustoDaOrdem,
  type ItemDaFilaComId,
} from '../services/aviso-de-custo-da-ordem.js'
import { lerEstadoBrutoDoAvisoDeCustoDaOrdem } from '../services/custo-da-ordem-do-projeto.js'
import { duvidaDeSeguimentoComoPublica } from '../services/duvidas-do-projeto.js'

// O ouvido do bot. Sem ele, o deep link do passo 8 abriria o Telegram, o cliente
// apertaria Start... e ninguém estaria escutando — o `chat_id` (a única coisa
// que torna o aviso possível) se perderia e o wizard ficaria "aguardando" para
// sempre.
//
// Long-polling (getUpdates), não webhook — a justificativa está em
// services/telegram-bot.ts. Um único long-poll de 30s por processo.
//
// Sem GITORCH_TELEGRAM_BOT_TOKEN, o plugin simplesmente não escuta (nada de
// bot = nada a ouvir); é assim que uma instalação sem Telegram roda em paz, e é
// por isso que o passo do wizard é opcional.

const POLL_TIMEOUT_SEC = 30
// Backoff quando o Telegram está fora / a rede caiu: não martelar a API.
const ERROR_BACKOFF_MS = 15_000

/**
 * Fix-up (revisão, defeito 4): usado por `comentarNaIssue`
 * (`aoResponderDuvidaDoDev`, abaixo) ANTES de montar a URL do GitHub —
 * `criarComentarNaIssue` (suposicao-imediata-de-duvida.ts) recebe
 * `repository: string` e confia cegamente nisso. O TypeScript garante que
 * `wingId` é sempre `string` no schema (nunca opcional) — mas o valor real
 * de um registro corrompido/legado pode chegar nulo ou vazio em tempo de
 * execução, e sem checar isto aqui a chamada seguia para
 * `https://api.github.com/repos/<vazio>/issues/...`: uma URL inválida que só
 * estourava (404 confuso do GitHub) várias chamadas depois, longe de onde o
 * dado já se mostrou ruim. Exportado para ser testável isoladamente (mesmo
 * padrão de `criarComentarNaIssue`/`parseDedupKeyDeDuvidaDoDev`).
 */
export function projetoTemRepositorioValido(
  projeto: { wingId?: string | null | undefined } | null | undefined
): projeto is { wingId: string } {
  return !!projeto && typeof projeto.wingId === 'string' && projeto.wingId.trim().length > 0
}

export const telegramPlugin = fp(async (app: FastifyInstance) => {
  const botToken = process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN']

  // Notifica o dono de uma AgentQuestion nova pelo Telegram (épico W3.3): sem
  // vínculo, no-op — a dúvida já existe e o painel é sempre o fallback
  // (contrato best-effort de AgentQuestionService.ask). Guarda o message_id
  // devolvido pra futura edição/confirmação (`telegramMessageId`). SÓ existe
  // com bot token — sem ele, `ask()` cria a dúvida mas não notifica (degrada
  // com clareza, nunca lança).
  const notifyOwner = botToken
    ? async (question: AgentQuestionRecord): Promise<void> => {
        const chatId = await resolveNotifyChatId(app.prisma, { userId: question.userId })
        if (!chatId) return

        const options = Array.isArray(question.options)
          ? (question.options as unknown as { label: string; value: string }[])
          : []
        const messageId = await sendTelegramQuestion({
          botToken,
          chatId,
          questionId: question.id,
          text: question.text,
          options,
        })
        if (messageId !== undefined) {
          await app.prisma.agentQuestion.update({
            where: { id: question.id },
            data: { telegramMessageId: messageId },
          })
        }
      }
    : undefined

  // A API interna que qualquer agente chama pra registrar uma dúvida
  // (docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md). O
  // notify real (Telegram) e o Cortex (memória de longo prazo das decisões)
  // ficam ligados aqui — é este service que também resolve o clique do botão
  // (`handleTelegramCallback`, abaixo).
  //
  // DECORADO SEMPRE (mesmo sem bot token, mesmo em teste): outras rotas que
  // registram dúvidas (ex.: routes/dev-agent-question.ts, W3.5.1) reusam esta
  // MESMA instância via `app.agentQuestionService`, pra criar E notificar
  // pelo mesmo caminho de produção em vez de duplicar a ligação com o Cortex.
  // D63/L4-T2: quando a dúvida respondida é sobre uma automação do cliente
  // (dedupKey `automacao:<repo>:<identidade>`), a resposta vira ação
  // (deletar/reajustar/manter/texto livre) — `AgentQuestionService` não sabe
  // nada de GitHub; só delega para cá. C4 (fix-up): `AgentQuestionService.
  // answer()` agora chama isto ANTES de marcar `status: 'answered'` — uma
  // falha AQUI (lançada, nunca engolida) mantém a pergunta `open` para nova
  // tentativa, em vez de fingir que a ação aconteceu.
  const aoResponderAutomacao = async (args: {
    dedupKey: string
    resposta: string
    projectId: string
    autonomia: string | null | undefined
  }): Promise<void> => {
    const projeto = await app.prisma.project.findUnique({
      where: { id: args.projectId },
      select: { wingId: true, userId: true, encryptedClientToken: true },
    })
    // C5 (fix-up L4-T2): nunca retorno silencioso — sem o projeto não há
    // como agir, e devolver sem erro faria `answer()` achar que a decisão
    // foi executada (a issue fica presa sem PR/comentário nenhum).
    if (!projeto) {
      app.log.error(
        `[Telegram] decisão de automação: projeto ${args.projectId} não encontrado (dedupKey ${args.dedupKey})`
      )
      throw new Error(`aoResponderAutomacao: projeto ${args.projectId} não encontrado`)
    }
    const token = await lerCredencialQueAlcancaOProjeto({
      prisma: app.prisma,
      projectId: args.projectId,
      userId: projeto.userId,
      engineConnections: app.engineConnections,
      encryptedClientTokenJaLido: projeto.encryptedClientToken,
    })
    if (!token) {
      // C5 (fix-up L4-T2): idem — `warn` + retorno silencioso deixava
      // `answer()` marcar a pergunta `answered` sem NENHUMA ação executada
      // (nem PR, nem label, nem comentário). Nível `error` + lança.
      app.log.error(
        `[Telegram] decisão de automação: sem credencial para ${projeto.wingId} (proj ${args.projectId}, dedupKey ${args.dedupKey})`
      )
      throw new Error(
        `aoResponderAutomacao: sem credencial do GitHub para ${projeto.wingId} — decisão não executada`
      )
    }
    await processarRespostaDeAutomacao(args, {
      fetchImpl: fetchDoRepositorio({ nivel: () => args.autonomia }),
      token,
      // A2 (fix-up L4-T2): o número da proposta vem da linha de
      // `infra_incidents` — nunca de um `context` reparseado.
      buscarIncidente: async ({ projectId, identidadeEstavel }) => {
        const incidente = await app.prisma.infraIncident.findUnique({
          where: { projectId_identidadeEstavel: { projectId, identidadeEstavel } },
          select: { issueNumber: true },
        })
        return incidente ? { issueNumber: incidente.issueNumber } : null
      },
      marcarIncidenteResolvido: async ({ projectId, identidadeEstavel }) => {
        await app.prisma.infraIncident.update({
          where: { projectId_identidadeEstavel: { projectId, identidadeEstavel } },
          data: { clearedAt: new Date() },
        })
      },
      onInfo: (m) => app.log.info(`[Telegram] ${m}`),
      onWarn: (m) => app.log.warn(`[Telegram] ${m}`),
    })
  }

  // A API interna que qualquer agente chama pra registrar uma dúvida
  // (docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md). O
  // notify real (Telegram) e o Cortex (memória de longo prazo das decisões)
  // ficam ligados aqui — é este service que também resolve o clique do botão
  // (`handleTelegramCallback`, abaixo).
  //
  // DECORADO SEMPRE (mesmo sem bot token, mesmo em teste): outras rotas que
  // registram dúvidas (ex.: routes/dev-agent-question.ts, W3.5.1) reusam esta
  // MESMA instância via `app.agentQuestionService`, pra criar E notificar
  // pelo mesmo caminho de produção em vez de duplicar a ligação com o Cortex.
  // L4-T3: a resposta do dono a uma dúvida escalada do dev assíncrono
  // (dedupKey `duvida-dev:*`) RETOMA a sessão dele —
  // `services/retomar-sessao-com-resposta.ts` resolve a chave BYOK (D34) e
  // manda a mensagem pelo mesmo caminho de produção do Jules. Mesma
  // disciplina do gancho de automação acima: o logger é o INJETADO
  // (`app.log`), nunca `console.warn`.
  const aoResponderDuvidaDoDev = async (args: {
    dedupKey: string
    resposta: string
    // S1 (fix-up 2, CSO): repassados direto da agent_question — nunca
    // resolvidos aqui por nome de repositório.
    projectId: string
    userId: string
    opcoes: Array<{ label: string; value: string }>
    // D2 (fix-up 6, task a13a42f8-2953-4259-b41f-3f8cddb304cd): repassado
    // direto para `retomarSessaoComResposta` — `assumida` significa que o
    // dono está corrigindo uma suposição do RA já entregue ao dev.
    statusAnterior?: string
  }): Promise<ResultadoDoManipuladorDeResposta | void> => {
    const resultado = await retomarSessaoComResposta(args, {
      prisma: app.prisma as unknown as PrismaParaRetomada,
      decifrar: decryptCredential,
      julesApiKeyDaInstancia: process.env['JULES_API_KEY'],
      // L4-T21 — defeito medido em produção (issue #309, 02/09 21:07 UTC):
      // correção do dono numa suposição sem sessão viva do dev não pode
      // mais se perder. Construído PREGUIÇOSAMENTE (só quando
      // `retomar-sessao-com-resposta.ts` realmente precisa comentar — o
      // caminho feliz, de longe o mais comum, nunca paga o custo desta
      // segunda consulta de projeto/credencial). MESMO padrão de
      // `aoResponderRetomadaTravadaHandler` logo abaixo: credencial do
      // repositório guardada pela autonomia do projeto, nunca um `fetch`
      // cru.
      comentarNaIssue: async ({ issueNumber, texto }) => {
        const projeto = await app.prisma.project.findUnique({
          where: { id: args.projectId },
          select: { wingId: true, userId: true, encryptedClientToken: true, autonomia: true },
        })
        if (!projeto) {
          app.log.warn(
            `[Telegram] correção do dono sem sessão viva: projeto ${args.projectId} não encontrado ` +
              `para comentar na issue #${issueNumber}`
          )
          return
        }
        // Fix-up (revisão, defeito 4): o código validava `!projeto` mas NUNCA
        // `!projeto.wingId` — um projeto achado com o identificador do
        // repositório nulo/vazio (registro corrompido/legado) seguia direto
        // para `criarComentarNaIssue({ repository: projeto.wingId, ... })`,
        // que monta `https://api.github.com/repos/<vazio ou null>/issues/...`
        // — uma URL inválida que só estoura (erro confuso, 404 do GitHub)
        // várias chamadas depois, em vez de um aviso claro aqui, no ponto
        // onde o dado já se mostrou ruim.
        if (!projetoTemRepositorioValido(projeto)) {
          app.log.warn(
            `[Telegram] correção do dono sem sessão viva: projeto ${args.projectId} sem ` +
              `identificador de repositório (wingId) válido — pulei o comentário na issue #${issueNumber}`
          )
          return
        }
        const token = await lerCredencialQueAlcancaOProjeto({
          prisma: app.prisma,
          projectId: args.projectId,
          userId: projeto.userId,
          engineConnections: app.engineConnections,
          encryptedClientTokenJaLido: projeto.encryptedClientToken,
        })
        const fetchImpl = fetchDoRepositorio({ nivel: () => projeto.autonomia })
        await criarComentarNaIssue({
          fetchDoCliente: fetchImpl,
          repository: projeto.wingId,
          githubToken: token ?? undefined,
          onWarn: (m) => app.log.warn(`[Telegram] ${m}`),
        })({ issueNumber, texto })
      },
      onWarn: (m) => app.log.warn(`[Telegram] ${m}`),
    })
    // Fix-up (revisão, defeito 5): extraído para
    // `manipuladorDeResultadoDeRetomada` (retomar-sessao-com-resposta.ts) —
    // antes, este `if` só sabia avisar o dono para `motivo ===
    // 'sem-sessao-viva'`; qualquer outro `{ entregue: false }` (incluindo o
    // caso de chave malformada, que agora tem motivo próprio) caía direto
    // no `return` implícito de sucesso, perdendo a correção do dono em
    // silêncio. `manipuladorDeResultadoDeRetomada` LANÇA para
    // 'chave-malformada' — a exceção sobe por aqui, mantém a pergunta
    // `open` (agent-question.ts answer()) e o painel devolve 409
    // (ERRO_AO_RESPONDER) em vez de fingir sucesso.
    return manipuladorDeResultadoDeRetomada(resultado)
  }

  // C2 (fix-up L4-T5, CSO): a resposta do dono à escalada de "PR travado em
  // retomada" (dedupKey `retomada-travada:<repo>:<pr>`,
  // `retomarPrReprovado.perguntarAoDono`, plugins/scheduler.ts) tinha 4
  // opções e NINGUÉM as consumia — a pergunta desaparecia da tela e nada
  // acontecia. `services/responder-retomada-travada.ts` decide o QUÊ (puro);
  // aqui é só a injeção: a MESMA credencial do repositório que
  // `aoResponderAutomacao` usa (leitura/escrita guardada pelo nível de
  // autonomia do projeto) e a MESMA resolução de chave do dev assíncrono
  // (BYOK, D34) que o resto do produto usa para abrir sessão nova.
  const depsDaChaveDoDevParaRetomada = {
    prisma:
      app.prisma as unknown as import('../services/chave-do-dev-assincrono.js').PrismaParaChaveDoDev,
    decifrar: decryptCredential,
    chaveDaInstancia: process.env['JULES_API_KEY'],
    onWarn: (m: string) => app.log.warn(`[Telegram] ${m}`),
  }
  const aoResponderRetomadaTravadaHandler = async (args: {
    dedupKey: string
    resposta: string
    projectId: string
  }): Promise<void> => {
    const projeto = await app.prisma.project.findUnique({
      where: { id: args.projectId },
      select: { wingId: true, userId: true, encryptedClientToken: true, autonomia: true },
    })
    if (!projeto) {
      app.log.error(
        `[Telegram] retomada travada: projeto ${args.projectId} não encontrado (dedupKey ${args.dedupKey})`
      )
      throw new Error(`aoResponderRetomadaTravada: projeto ${args.projectId} não encontrado`)
    }
    const token = await lerCredencialQueAlcancaOProjeto({
      prisma: app.prisma,
      projectId: args.projectId,
      userId: projeto.userId,
      engineConnections: app.engineConnections,
      encryptedClientTokenJaLido: projeto.encryptedClientToken,
    })
    if (!token) {
      app.log.error(
        `[Telegram] retomada travada: sem credencial para ${projeto.wingId} (proj ${args.projectId})`
      )
      throw new Error(
        `aoResponderRetomadaTravada: sem credencial do GitHub para ${projeto.wingId} — ação não executada`
      )
    }
    const fetchImpl = fetchDoRepositorio({ nivel: () => projeto.autonomia })
    const gh = <T = unknown>(method: string, path: string, body?: unknown): Promise<T> =>
      ghJson<T>(fetchImpl, token, method, `https://api.github.com${path}`, body)

    await aoResponderRetomadaTravada(args, {
      prisma: app.prisma as unknown as PrismaParaRetomadaTravada,
      lerPr: async ({ repository, prNumber }) => {
        const pr = await gh<{ head?: { ref?: string } }>(
          'GET',
          `/repos/${repository}/pulls/${prNumber}`
        )
        return pr.head?.ref ? { headRef: pr.head.ref } : null
      },
      comentar: async ({ repository, prNumber, comentario }) => {
        await gh('POST', `/repos/${repository}/issues/${prNumber}/comments`, { body: comentario })
      },
      fecharPr: async ({ repository, prNumber }) => {
        await gh('PATCH', `/repos/${repository}/pulls/${prNumber}`, { state: 'closed' })
      },
      criarSessaoDev: async ({ repository, startingBranch, workingBranch, titulo, prompt }) =>
        criarSessaoJules({
          apiKey:
            (await resolverChaveDoDevDoProjeto(depsDaChaveDoDevParaRetomada, args.projectId)) ??
            undefined,
          repository,
          startingBranch,
          workingBranch,
          titulo,
          prompt,
          onWarn: (m) => app.log.warn(`[Telegram] ${m}`),
        }),
      registrarSessaoRetomada: async ({ issueNumber, sessionName, prNumber }) => {
        const agora = new Date()
        const aberta = await abrirSessao({
          prisma: app.prisma as unknown as PrismaDevSession,
          projectId: args.projectId,
          issueNumber,
          sessionName,
          agora,
        })
        if (!aberta.ok) {
          throw new Error(
            `aoResponderRetomadaTravada: já existe sessão viva para a issue #${issueNumber} ` +
              `(${aberta.motivo}) — a sessão ${sessionName} ficou órfã no dev assíncrono`
          )
        }
        await registrarPr({
          prisma: app.prisma as unknown as PrismaDevSession,
          sessionName,
          numeroDoPr: prNumber,
          agora,
        })
      },
      onWarn: (m) => app.log.warn(`[Telegram] ${m}`),
      onInfo: (m) => app.log.info(`[Telegram] ${m}`),
    })
  }

  // L4-T18 (item 2) — a resposta à pergunta de custo da ordem
  // (dedupKey `custo-da-ordem:<repo>:<pedido>`, `perguntarSobreCustoDaOrdem`
  // em plugins/scheduler.ts) vira ação de verdade.
  // `processarRespostaDeCustoDaOrdem` (aviso-de-custo-da-ordem.ts) decide o
  // QUÊ (puro, sem rede); aqui é só a injeção — a MESMA leitura de quadro
  // que `avaliarCustoDaOrdem` (scheduler.ts) já faz para calcular o
  // candidato, e a MESMA escrita que a rota `POST /api/v1/painel/ordem`
  // (routes/painel.ts) já usa para reordenar de verdade
  // (`aplicarOrdemDosPedidos`).
  const aoResponderCustoDaOrdem = async (args: {
    dedupKey: string
    resposta: string
    projectId: string
  }): Promise<ResultadoDoManipuladorDeResposta | void> => {
    const parsedDedupKey = parseDedupKeyDeCustoDaOrdem(args.dedupKey)
    const projeto = await app.prisma.project.findUnique({
      where: { id: args.projectId },
      select: {
        wingId: true,
        userId: true,
        encryptedClientToken: true,
        autonomia: true,
        runtimeConfig: true,
      },
    })
    if (!projeto) {
      app.log.error(
        `[Telegram] custo-da-ordem: projeto ${args.projectId} não encontrado (dedupKey ${args.dedupKey})`
      )
      throw new Error(`aoResponderCustoDaOrdem: projeto ${args.projectId} não encontrado`)
    }
    const quadro = resolveQuadroDoProjeto(projeto.runtimeConfig)
    if (!quadro) {
      app.log.error(
        `[Telegram] custo-da-ordem: projeto ${args.projectId} sem quadro (dedupKey ${args.dedupKey})`
      )
      throw new Error(`aoResponderCustoDaOrdem: projeto ${args.projectId} sem quadro ligado`)
    }
    const token = await lerCredencialQueAlcancaOProjeto({
      prisma: app.prisma,
      projectId: args.projectId,
      userId: projeto.userId,
      engineConnections: app.engineConnections,
      encryptedClientTokenJaLido: projeto.encryptedClientToken,
    })
    if (!token) {
      app.log.error(
        `[Telegram] custo-da-ordem: sem credencial para ${projeto.wingId} (proj ${args.projectId})`
      )
      throw new Error(
        `aoResponderCustoDaOrdem: sem credencial do GitHub para ${projeto.wingId} — ação não executada`
      )
    }

    const cliente = new ProjectV2Client({
      token,
      fetchImpl: fetchDoRepositorio({ nivel: () => projeto.autonomia }),
    })
    // Resolvido no máximo uma vez por resposta — "aplicar" e "ver a fila"
    // podem precisar dele, "manter" nunca chega a pedir.
    let quadroIdCache: string | null | undefined
    const resolverQuadroId = async (): Promise<string | null> => {
      if (quadroIdCache !== undefined) return quadroIdCache
      quadroIdCache =
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
      return quadroIdCache
    }

    const salvarCustoDaOrdem = async (estado: {
      ultimoPedidoProposto: number | null
      silencio: { pedido: number; ate: string; rodada: number } | null
      /** Item 3 (fix-up L4-T18) — `null` limpa a ordem guardada (nenhuma
       *  pergunta viva propõe mais nada). */
      ordemProposta: number[] | null
    }): Promise<void> => {
      // MESCLA rasa, nunca substituição — mesmo padrão de `salvarEstado`
      // (scheduler.ts) e de `agent-question.ts`.
      const linha = await app.prisma.project.findUnique({
        where: { id: args.projectId },
        select: { runtimeConfig: true },
      })
      const atual = (linha?.runtimeConfig as Record<string, unknown> | null) ?? {}
      await app.prisma.project.update({
        where: { id: args.projectId },
        data: {
          // Literal fresco, não a variável tipada: o Prisma exige
          // `InputJsonObject` (com assinatura de índice) — mesmo motivo do
          // comentário equivalente em `salvarEstado` (scheduler.ts).
          runtimeConfig: {
            ...atual,
            custoDaOrdem: {
              ultimoPedidoProposto: estado.ultimoPedidoProposto,
              silencio: estado.silencio
                ? {
                    pedido: estado.silencio.pedido,
                    ate: estado.silencio.ate,
                    rodada: estado.silencio.rodada,
                  }
                : null,
              ordemProposta: estado.ordemProposta,
            },
          },
        },
      })
    }

    return processarRespostaDeCustoDaOrdem(
      { dedupKey: args.dedupKey, resposta: args.resposta },
      {
        filaAtual: async (): Promise<ItemDaFilaComId[] | null> => {
          const quadroId = await resolverQuadroId()
          if (!quadroId) return null
          let leituraIncompleta = false
          const itens = await cliente.listarItensDoQuadro(quadroId, {
            campoDePeso: 'Peso',
            comCorpo: true,
            onTruncado: () => {
              leituraIncompleta = true
            },
          })
          // Leitura cortada: a fila que sobrou não é a fila real — mesma
          // prudência de `avaliarCustoDaOrdem` (scheduler.ts).
          if (leituraIncompleta) return null
          const filtro = filtrarFilaDeTasks(itens)
          if (!filtro.fila) return null
          const itemIdPorPedido = new Map(itens.map((i) => [i.pedido, i.itemId]))
          const comId: ItemDaFilaComId[] = []
          for (const p of filtro.fila) {
            const itemId = itemIdPorPedido.get(p.pedido)
            if (itemId) comId.push({ pedido: p.pedido, peso: p.peso, itemId })
          }
          return comId
        },
        // Item 3 (fix-up L4-T18) — a ordem GUARDADA junto com a pergunta
        // (custo-da-ordem-do-projeto.ts escreve, na MESMA leitura de
        // `Project.runtimeConfig.custoDaOrdem` que `scheduler.ts` usa).
        // Reusa o parser PURO e testado (`lerEstadoBrutoDoAvisoDeCustoDaOrdem`)
        // em vez de duplicar este parsing uma terceira vez.
        ordemProposta: async (): Promise<number[] | null> => {
          const linha = await app.prisma.project.findUnique({
            where: { id: args.projectId },
            select: { runtimeConfig: true },
          })
          const bruto = (linha?.runtimeConfig as Record<string, unknown> | null)?.['custoDaOrdem']
          return lerEstadoBrutoDoAvisoDeCustoDaOrdem(bruto).ordemProposta
        },
        aplicarOrdem: async (pedidos) => {
          const quadroId = await resolverQuadroId()
          if (!quadroId) {
            // Item 7 (fix-up L4-T18, revisão de portão) — registrar a causa
            // ANTES de lançar, igual às outras 3 recusas desta mesma função
            // (projeto não encontrado / sem quadro / sem credencial, acima):
            // sem isto, a falha de aplicar a troca não deixava rastro
            // nenhum no log — só a exceção, sem contexto, subindo para
            // `answer()` (agent-question.ts).
            app.log.error(
              `[Telegram] custo-da-ordem: não achei o quadro de ${projeto.wingId} para aplicar ` +
                `a troca (proj ${args.projectId}, dedupKey ${args.dedupKey})`
            )
            throw new Error(
              `aoResponderCustoDaOrdem: não achei o quadro de ${projeto.wingId} para aplicar a troca`
            )
          }
          await aplicarOrdemDosPedidos(
            {
              quadro: cliente,
              nivel: () => projeto.autonomia,
              registrar: async (r) => {
                await app.prisma.event.create({
                  data: {
                    projectId: args.projectId,
                    type: 'painel_escreveu',
                    payload: { texto: r.oQueFiz, ordem: r.ordem, quando: r.quando },
                  },
                })
              },
            },
            { projectId: quadroId, pedidos }
          )
        },
        silenciarCandidato: async ({ pedido, ate }) => {
          await salvarCustoDaOrdem({
            ultimoPedidoProposto: pedido,
            silencio: { pedido, ate: ate.toISOString(), rodada: parsedDedupKey?.rodada ?? 1 },
            // A ordem guardada é desta pergunta, que está se resolvendo
            // agora (manter, ver-a-fila, ou fila mudada) — a PRÓXIMA
            // pergunta (nova rodada) grava a SUA PRÓPRIA ordem, calculada
            // da fila fresca daquele momento (custo-da-ordem-do-projeto.ts).
            ordemProposta: null,
          })
        },
        limparEstadoAposAplicar: async () => {
          await salvarCustoDaOrdem({
            ultimoPedidoProposto: null,
            silencio: null,
            ordemProposta: null,
          })
        },
        onInfo: (m) => app.log.info(`[Telegram] ${m}`),
        onWarn: (m) => app.log.warn(`[Telegram] ${m}`),
      }
    )
  }

  // L4-T18 fix-up (itens 5/6, revisão de portão) — "outro" na pergunta de
  // como publica (`duvidaSobreComoPublica`, duvidas-do-projeto.ts, reduzida
  // para 3 opções porque `sendTelegramQuestion` passou a recusar mais de 3)
  // dispara o 2º passo, que distingue serviço externo de manual SEM PERDER
  // informação. `duvidaDeSeguimentoComoPublica` é PURA (decide o quê); aqui
  // é só a injeção — chama `ask()` de novo, na MESMA dedupKey, quando ela
  // devolve uma pergunta de seguimento; para qualquer outra resposta
  // (workflow, vm-própria, texto livre) devolve `null` e este manipulador
  // não faz nada, deixando `configuracaoAPartirDaResposta`
  // (como-o-projeto-publica.ts, chamada incondicionalmente por `answer()`)
  // gravar a config como sempre.
  const aoResponderComoPublica = async (args: {
    dedupKey: string
    resposta: string
    projectId: string
    userId: string
  }): Promise<void> => {
    const seguimento = duvidaDeSeguimentoComoPublica(args.dedupKey, args.resposta)
    if (!seguimento) return
    await agentQuestionService.ask(args.userId, args.projectId, seguimento)
  }

  const agentQuestionService = new AgentQuestionService(app.prisma, {
    ...(notifyOwner ? { notify: notifyOwner } : {}),
    cortex: app.cortex,
    // A1 (fix-up L4-T3): registro por prefixo — substitui os dois campos
    // fixos `aoResponderAutomacao`/`aoResponderDuvidaDoDev`. A ORDEM não
    // importa aqui (prefixos `automacao:`/`duvida-dev:` nunca colidem), mas
    // é a mesma disciplina que qualquer prefixo novo (L4-T4/T9/T18) vai
    // seguir: uma entrada nova nesta lista, nunca mais um `if` em
    // `agent-question.ts`.
    manipuladoresDeResposta: [
      { prefixo: 'automacao:', executar: aoResponderAutomacao },
      { prefixo: 'duvida-dev:', executar: aoResponderDuvidaDoDev },
      { prefixo: 'retomada-travada:', executar: aoResponderRetomadaTravadaHandler },
      { prefixo: 'custo-da-ordem:', executar: aoResponderCustoDaOrdem },
      { prefixo: 'como-publica:', executar: aoResponderComoPublica },
    ],
    // C4 (fix-up L4-T2): logger injetado para a falha de um manipulador de
    // resposta — nunca `console.warn`, que some do monitoramento.
    onError: (m) => app.log.error(`[Telegram] ${m}`),
  })
  app.decorate('agentQuestionService', agentQuestionService)

  // Em teste não se abre laço nem socket (paridade com o scheduler): a lógica
  // toda é testada nos serviços, sem rede. Em modo pipeline-check (F2.3/P1-2)
  // também não: a instância de verificação escutando o MESMO bot que a prod
  // viva causaria 409 no getUpdates (ver config/pipeline-check.ts).
  const pipelineCheck = pipelineCheckEnabled()
  if (!botToken || process.env['NODE_ENV'] === 'test' || pipelineCheck) {
    if (!botToken) {
      app.log.info('[Telegram] sem GITORCH_TELEGRAM_BOT_TOKEN — o bot não será ouvido')
    } else if (pipelineCheck) {
      app.log.warn(
        '[Telegram] GITORCH_PIPELINE_CHECK=1: bot NÃO será ouvido (evita 409 contra a prod viva)'
      )
    }
    return
  }

  // NUNCA `app.ready()` aqui: chamar ready() de dentro de um plugin BOOTA O ROOT, e todo
  // `app.get()` registrado depois (routes/index.ts inteiro, a começar por healthRoutes)
  // estoura AVV_ERR_ROOT_PLG_BOOTED — o processo morre no arranque e o serviço entra em
  // crash-loop. Passou no CI porque o guard acima retorna quando NODE_ENV==='test', então
  // este trecho só executa fora de teste: quebrou em produção, no primeiro restart depois
  // do PR #394 (31/08, 502 no site). `onReady` agenda o mesmo callback sem bootar o root.
  app.addHook('onReady', async () => {
    if ('emitter' in app) {
      // @ts-ignore
      app.emitter.on('pipeline.error', async (metadata: PipelineErrorMetadata) => {
        const ownerEmail = process.env['GITORCH_OWNER_EMAIL']
        if (!ownerEmail) return

        const user = await app.prisma.user.findUnique({
          where: { email: ownerEmail },
          select: { id: true, email: true },
        })
        if (!user) return

        const chatId = await resolveNotifyChatId(app.prisma, {
          userId: user.id,
          user: { email: user.email },
        })
        if (!chatId) return

        // Extrai o code, remove a chave se for algo como "CODE: message"
        let errorCode = metadata.reason
        const match = /^([A-Z_]+):\s/.exec(errorCode)
        if (match && match[1]) {
          errorCode = match[1]
        }

        const translatedReason = traduzirErroParaUsuario(errorCode as SetupErrorCode | null)
        const actionRequired = metadata.requiresAction ? 'Sim' : 'Não'
        const text = `🚨 Sua entrega falhou no passo ${metadata.step}. O que quebrou: ${translatedReason}. O que fizemos: ${metadata.mitigationAction}. Ação necessária: ${actionRequired}`

        app.log.info({ payload: text }, '[Telegram] enviando aviso de falha na pipeline')

        await sendTelegramMessage({
          botToken,
          chatId,
          text,
        })
      })
    }
  })

  // A porta do desejo pelo mensageiro. O pedido em linguagem de gente vira a
  // MESMA issue oficial que a tela cria (ver routes/index.ts) — quem escreve é
  // o serviço compartilhado, então o registro nasce igual venha de onde vier.
  const desejoDeps: TelegramDesejoDeps = {
    // O chat só vale como identidade quando está vinculado a UMA conta: é o
    // vínculo que diz de QUEM ele é, e portanto em qual repositório o pedido
    // pode ser escrito. Chat com duas contas volta `ambiguo` e o pedido é
    // recusado — jamais escrito num repositório sorteado.
    donoDoChat: (chatId) => resolveDonoDoChat(app.prisma, chatId),
    // A MESMA regra da porta HTTP (services/projetos-do-desejo.ts): enquanto
    // cada porta escreveu o próprio filtro, elas divergiram sobre projeto
    // desativado e o dono recebia duas respostas para o mesmo fato.
    projetosDoDono: (userId) => projetosParaDesejo(app.prisma, userId),
    // Defesa em profundidade, e a MESMA função que a porta HTTP usa
    // (routes/index.ts): o acesso ao repositório foi provado uma vez, no
    // wizard, e o endereço virou `project.wingId` para sempre. Removido da
    // organização depois, o dono continuaria mandando pedido daqui e o produto
    // escreveria no repositório alheio com a credencial da instalação.
    confirmarAcesso: provaDeEscritaNoUso(app.engineConnections),
    // Comando endereçado a outro bot do grupo não é nosso. O nome sai da mesma
    // fonte que monta o deep link do wizard.
    nomeDoBot: telegramBotUsername(),
    // Achado A (revisão do fix-up 2): "ao nascer" a issue de desejo pelo
    // Telegram passa por `nascerDesejo` — o MESMO caminho único da porta
    // HTTP (routes/index.ts) e da varredura periódica. Sem decisão 'usar'
    // de quadro, a issue nasce igual, sem card, e o motivo vira log.
    criarIssue: ({ repo, titulo, corpo, etiquetas, projectId }) =>
      nascerDesejo(
        {
          projectId,
          repo,
          titulo,
          corpo,
          etiquetas,
          log: { onError: (m) => app.log.error(m), onWarn: (m) => app.log.warn(m) },
        },
        {
          prisma: app.prisma,
          engineConnections: app.engineConnections,
          onInfo: (m) => app.log.info(`[Telegram] ${m}`),
        }
      ),
    // O pedido que ainda não sabe o projeto vive no BANCO, nunca na memória
    // do processo: entre a pergunta e o toque no botão o serviço reinicia
    // várias vezes por dia, e o dono clicaria no vazio.
    guardarPendente: async ({ userId, chatId, texto }) => {
      // Limpeza oportunista, aqui e não num cron: quem escreve um pedido novo
      // é exatamente quem pode ter deixado pedidos velhos para trás. Sem isto
      // a tabela só cresce — nada mais no produto apaga uma linha dela.
      try {
        await app.prisma.pedidoDeDesejoPendente.deleteMany({
          where: { userId, createdAt: { lt: new Date(Date.now() - PRAZO_DO_PENDENTE_MS) } },
        })
      } catch (erro) {
        // Faxina que falha não pode impedir o pedido de nascer.
        app.log.warn(erro, '[Telegram] limpeza de pedidos pendentes vencidos falhou')
      }
      return app.prisma.pedidoDeDesejoPendente.create({
        data: { userId, chatId, texto },
        select: { id: true },
      })
    },
    lerPendente: (id) =>
      app.prisma.pedidoDeDesejoPendente.findUnique({
        where: { id },
        select: {
          id: true,
          userId: true,
          chatId: true,
          texto: true,
          usadoEm: true,
          createdAt: true,
        },
      }),
    // Só carimba o que AINDA não foi usado. Assim duas entregas do mesmo
    // clique disputando entre si só deixam uma passar — e quem perde recebe
    // `false`, não uma exceção: perder a disputa não é falha, é a outra
    // entrega tendo registrado o pedido.
    marcarPendenteUsado: async (id) => {
      const alterados = await app.prisma.pedidoDeDesejoPendente.updateMany({
        where: { id, usadoEm: null },
        data: { usadoEm: new Date() },
      })
      return alterados.count > 0
    },
    registrarFalha: (erro) => app.log.error(erro, '[Telegram] falha ao registrar o desejo'),
  }

  let stopped = false
  const controller = new AbortController()
  let offset: number | undefined

  const listen = async (): Promise<void> => {
    app.log.info('[Telegram] ouvindo o bot (getUpdates)')
    while (!stopped) {
      try {
        const result = await getTelegramUpdates({
          botToken,
          offset,
          timeoutSec: POLL_TIMEOUT_SEC,
          signal: controller.signal,
        })

        if (result.conflict) {
          // 409: outro processo (ou um webhook) está pendurado no MESMO bot. Os
          // updates estão indo para ele — dizer "tudo certo" aqui seria mentir
          // para o cliente que aperta Start e nunca vincula.
          app.log.error(
            '[Telegram] 409 Conflict no getUpdates: outro ouvinte (ou um webhook) está ativo neste bot. ' +
              'Enquanto isso durar, o Start do cliente NÃO vincula aqui.'
          )
          await sleep(ERROR_BACKOFF_MS)
          continue
        }

        offset = result.nextOffset

        for (const update of result.updates) {
          if (update.callback_query) {
            // O toque no botão de PROJETO vem primeiro porque ele reconhece o
            // que é seu pelo prefixo e devolve `null` para todo o resto — a
            // dúvida do PO, que viaja no mesmo canal, segue intacta logo abaixo.
            const escolha = await tratarCliqueDeProjeto(desejoDeps, update)
            if (escolha) {
              // Tirar o "reloginho" do botão vem antes da resposta: é o único
              // sinal de que o toque foi recebido, e o registro da issue leva
              // segundos.
              await answerTelegramCallback({ botToken, callbackQueryId: escolha.callbackQueryId })
              // Botão usado para de ser clicável. Sem isto ele fica no
              // histórico parecendo vivo, e o dono toca de novo esperando algo.
              await zerarTecladoDaMensagem({
                botToken,
                chatId: escolha.chatId,
                messageId: update.callback_query.message?.message_id,
              })
              // Texto vazio é a reentrega do mesmo clique: a primeira já
              // respondeu, e repetir seria falar duas vezes com o dono.
              if (escolha.text !== '') {
                const entregue = await sendTelegramMessage({
                  botToken,
                  chatId: escolha.chatId,
                  text: escolha.text,
                })
                // A issue já nasceu e o pendente já foi carimbado. Se o recado
                // não chegou, o dono fica sem saber — e isso tem que aparecer
                // no log, nunca sumir.
                if (!entregue) {
                  app.log.error(
                    { chatId: escolha.chatId },
                    '[Telegram] pedido registrado mas a confirmação não chegou ao dono'
                  )
                }
              }
              continue
            }
            // Clique num botão de AgentQuestion (épico W3.3) — roteamento
            // próprio, com guard anti cross-tenant embutido em
            // handleTelegramCallback. Nunca é também um /start: são tipos de
            // update mutuamente exclusivos.
            //
            // L4-T27 (item 3) — defeito medido em produção (issue
            // GitOrchAI/gitorch#3866): `onError` é o que faz a falha
            // ISOLADA dentro de handleTelegramCallback aparecer de verdade
            // no log (nunca console.*) — sem isto configurado, o aviso
            // seria descartado em silêncio e ninguém saberia que um clique
            // falhou.
            await handleTelegramCallback(
              {
                prisma: app.prisma,
                agentQuestionService,
                botToken,
                onError: (m) => app.log.error(`[Telegram] ${m}`),
              },
              update
            )
            continue
          }
          // Reply (o dono respondeu à MENSAGEM da pergunta) — casa com a
          // AgentQuestion aberta via `message.reply_to_message` (feedback do
          // dono: falta uma 4ª resposta manual quando nenhuma opção serve).
          // Só entra aqui quando FOI de fato um reply a uma pergunta nossa;
          // qualquer outra mensagem (ex.: um /start) segue pro fluxo normal
          // logo abaixo.
          //
          // FIX-UP L4-T27 (revisão, item 1): `onError` é o que faz a falha
          // ISOLADA dentro de handleTelegramQuestionReply aparecer de
          // verdade no log (nunca console.*) — MESMO onError que o clique
          // (handleTelegramCallback, acima) já recebe. Sem isto configurado,
          // uma falha ao registrar a resposta em texto livre seria
          // descartada em silêncio.
          const handledAsAnswer = await handleTelegramQuestionReply(
            {
              prisma: app.prisma,
              agentQuestionService,
              botToken,
              onError: (m) => app.log.error(`[Telegram] ${m}`),
            },
            update
          )
          if (handledAsAnswer) continue

          // `/desejo` (ou `/quero`): o pedido do dono em linguagem natural.
          // Vem depois do reply porque uma resposta a uma dúvida do agente é
          // outra conversa, e antes do /start porque mensagem solta que não é
          // desejo continua caindo no fluxo normal.
          const desejo = await tratarPedidoDeDesejo(desejoDeps, update)
          if (desejo) {
            await sendTelegramMessage({
              botToken,
              chatId: desejo.chatId,
              text: desejo.text,
              ...(desejo.teclado ? { teclado: desejo.teclado } : {}),
            })
            continue
          }

          if (update.message?.text?.trim().startsWith('/esperas')) {
            const chatId = update.message?.chat?.id
            if (chatId !== undefined && chatId !== null) {
              const waitingMissions = await app.prisma.mission.findMany({
                where: {
                  status: 'waiting',
                  waitingReason: { not: null },
                },
                select: {
                  waitingReason: true,
                  payload: true,
                },
              })

              let text = ''
              if (waitingMissions.length === 0) {
                text = '0 entregas aguardando.'
              } else {
                const parts = waitingMissions.map(
                  (m: { waitingReason: string | null; payload: unknown }) => {
                    const payload = m.payload as {
                      issueNumber?: number
                      issue_number?: number
                    } | null
                    const issueNumber = payload?.issueNumber ?? payload?.issue_number
                    const reason = m.waitingReason?.replace(/\n/g, ' ') || 'Motivo não especificado'
                    return issueNumber ? `#${issueNumber} - ${reason}` : reason
                  }
                )
                text = `${waitingMissions.length} entregas aguardando: ${parts.join(', ')}`
              }

              await sendTelegramMessage({
                botToken,
                chatId: String(chatId),
                text,
              })
            }
            continue
          }

          // `/wishlist` continua com a resposta de orientação que já existia na
          // linha principal. Fica DEPOIS do desejo porque são coisas diferentes:
          // aqui só se explica a sintaxe, enquanto `/desejo` e `/quero` abrem o
          // pedido de verdade.
          if (update.message?.text?.trim().startsWith('/wishlist')) {
            const chatId = update.message?.chat?.id
            if (chatId !== undefined && chatId !== null) {
              await sendTelegramMessage({
                botToken,
                chatId: String(chatId),
                text: 'Use /wishlist add <item>',
              })
            }
            continue
          }

          const reply = await handleTelegramUpdate(app.prisma, update, { agentQuestionService })
          if (!reply) continue
          await sendTelegramMessage({ botToken, chatId: reply.chatId, text: reply.text })
        }
      } catch (err) {
        if (stopped) return
        app.log.warn(err, '[Telegram] falha ao ouvir o bot; nova tentativa em breve')
        await sleep(ERROR_BACKOFF_MS)
      }
    }
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      // Não segura o processo no shutdown.
      timer.unref?.()
    })

  void listen()

  app.addHook('onClose', async () => {
    stopped = true
    controller.abort()
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * A instância ÚNICA de AgentQuestionService com notify (Telegram) + Cortex
     * já ligados (ver acima). Sempre decorada quando este plugin está
     * registrado — outras rotas reusam em vez de instanciar um serviço
     * "mudo" (sem notify) por engano.
     */
    agentQuestionService?: AgentQuestionService
  }
}

export default telegramPlugin
