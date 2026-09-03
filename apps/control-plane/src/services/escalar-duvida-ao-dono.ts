import type { AgentQuestionService, AskResult } from './agent-question.js'
import type { DestinoDaDuvida } from './duvida-do-dev.js'
import type { PrismaDevSession } from './dev-session-store.js'
import { registrarResposta, registrarEscalada } from './dev-session-store.js'
import { marcarRespondida } from './pergunta-sem-resposta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import { responderSessaoJules as responderSessaoJulesReal } from './jules-client.js'
import { textoDeEscaladaParaODono } from './texto-de-escalada.js'
import type { NotifiableProject } from './telegram-link.js'

export interface PrismaParaEscalarDuvida extends PrismaDevSession {
  project: {
    findUnique: (args: {
      where: { id: string }
    }) => Promise<
      (NotifiableProject & { id: string; wingId: string; userId: string | null }) | null
    >
  }
}

export interface DepsDeEscalarDuvida {
  prisma: PrismaParaEscalarDuvida
  agentQuestionService?: Pick<AgentQuestionService, 'ask'> | undefined
  /** Injetável para teste; produção passa `responderSessaoJules` de verdade. */
  responderSessaoJules?: typeof responderSessaoJulesReal
  onInfo: (mensagem: string) => void
  /** L4-T3/item 0: nunca `.catch(warn)` — a pergunta TEM de nascer; quem não
   *  conseguir loga ERROR (nunca silêncio) e a exceção sobe. */
  onError: (err: unknown, mensagem: string) => void
}

/**
 * Escala uma dúvida do dev assíncrono ao dono — DE VERDADE.
 *
 * Extraído de `plugins/scheduler.ts` (`responderDuvidaPendente`, ramo
 * `destino.tipo === 'perguntar-ao-dono'`) para virar testável sem a máquina
 * de missão/motor. O teste real de costura (`escalar-duvida-ao-dono.test.ts`)
 * reproduziu, com esta MESMA função, o defeito medido em 02/09 antes do
 * conserto: 24 sessões marcadas "respondida" ao escalar, ZERO
 * `agent_question` criada — porque `destinoAposRa` (services/duvida-do-dev.ts)
 * NUNCA popula `perguntaExecutiva`, e o código antigo caía para um aviso de
 * texto solto (`avisarDonoDoProjeto`) nesse caso, violando D71.
 *
 * O conserto, em três partes:
 *  1. `perguntar-ao-dono` SEMPRE vira `agentQuestionService.ask(...)` — nunca
 *     mais um aviso de texto solto. Sem `perguntaExecutiva` do modelo, usa
 *     `textoDeEscaladaParaODono` (PT-BR determinístico, com a pergunta
 *     original do dev quando disponível) em vez de desistir da pergunta.
 *  2. A marca vira `escalada:` (nunca `respondida:` — ninguém respondeu
 *     ainda), e só é gravada DEPOIS que a pergunta nasceu de verdade — nunca
 *     antes (mesmo princípio de `aoResponderAutomacao`, L4-T2: ação antes de
 *     gravar).
 *  3. `ask()` que falha (rede, Prisma) é ERRO ALTO — `onError` + a exceção
 *     sobe — nunca `.catch(warn)`. Sem isso a pergunta "morre" em silêncio e
 *     a sessão nunca mais tenta.
 *
 * `deduped: true` (a MESMA pergunta, mesmo dedupKey, já tinha sido
 * respondida antes) entrega a resposta anterior direto ao dev, em vez de
 * fazer o dono decidir de novo a mesma coisa.
 */
export async function escalarDuvidaAoDono(
  args: {
    destino: DestinoDaDuvida
    sessionName: string
    issueNumber: number
    repository: string
    projectId: string
    hashDaPergunta: string
    /** A pergunta original do dev — usada só no texto de RESERVA (PT-BR),
     *  quando o modelo não deixou `perguntaExecutiva` pronta. */
    pergunta: string
    /** A chave do dev assíncrono desta sessão — só usada no caminho
     *  `deduped` (entrega a resposta anterior direto ao dev). */
    apiKey: string | undefined
  },
  deps: DepsDeEscalarDuvida
): Promise<void> {
  const motivo =
    args.destino.tipo === 'perguntar-ao-dono' ? args.destino.motivo : 'sem resposta útil'
  deps.onInfo(
    `a dúvida do dev na tarefa #${args.issueNumber} de ${args.repository} sobe para o dono: ${motivo}`
  )

  const projeto = await deps.prisma.project.findUnique({ where: { id: args.projectId } })
  if (!projeto) {
    const mensagem =
      `escalarDuvidaAoDono: projeto ${args.projectId} não encontrado — a dúvida da tarefa ` +
      `#${args.issueNumber} de ${args.repository} NÃO foi escalada`
    deps.onError(new Error(mensagem), mensagem)
    throw new Error(mensagem)
  }

  const perguntador = deps.agentQuestionService
  if (!perguntador || !projeto.userId) {
    const motivoFalha = !perguntador ? 'agentQuestionService indefinido' : 'projeto sem userId'
    const mensagem =
      `escalarDuvidaAoDono: não deu para escalar a dúvida da tarefa #${args.issueNumber} de ` +
      `${args.repository} ao dono: ${motivoFalha} — a pergunta NÃO nasceu`
    deps.onError(new Error(mensagem), mensagem)
    throw new Error(mensagem)
  }

  // D14: quando o modelo já traduziu a decisão de negócio em PT-BR
  // (`perguntaExecutiva`), usa ela. Senão — `destinoAposRa` NUNCA carrega
  // este campo, e o próprio QA pode deixá-lo vazio de propósito — usa o
  // texto de RESERVA determinístico, nunca um aviso de texto solto (D71).
  const perguntaExecutivaDoModelo =
    args.destino.tipo === 'perguntar-ao-dono' ? args.destino.perguntaExecutiva : undefined
  const opcoesDoModelo =
    args.destino.tipo === 'perguntar-ao-dono' ? (args.destino.opcoes ?? []) : []
  const textoDaPergunta =
    perguntaExecutivaDoModelo ??
    textoDeEscaladaParaODono({
      issueNumber: args.issueNumber,
      repository: args.repository,
      pergunta: args.pergunta,
    })
  const dedupKey = `duvida-dev:${args.repository}:${args.issueNumber}:${args.hashDaPergunta}`

  let resultado: AskResult
  try {
    resultado = await perguntador.ask(projeto.userId, args.projectId, {
      text: textoDaPergunta,
      context: `Tarefa #${args.issueNumber} de ${args.repository} — o dev assíncrono está parado esperando esta decisão.`,
      // Objetivas (o modelo) + a aberta (sempre presente, determinística):
      // "3 objetivas + 1 aberta" é o formato que o dono sempre pede (D71).
      options: [...opcoesDoModelo, buildFreeTextOption()],
      dedupKey,
    })
  } catch (err) {
    const mensagem =
      `escalarDuvidaAoDono: não deu para perguntar ao dono (agent-question) sobre a tarefa ` +
      `#${args.issueNumber} de ${args.repository} — a pergunta NÃO nasceu`
    deps.onError(err, mensagem)
    throw err
  }

  if (resultado.deduped) {
    // A MESMA pergunta (dedupKey) já tinha sido decidida antes: entrega a
    // resposta anterior direto ao dev, em vez de fazer o dono decidir de
    // novo a mesma coisa.
    if (!resultado.question.answer) return
    const responder = deps.responderSessaoJules ?? responderSessaoJulesReal
    const saiu = await responder({
      apiKey: args.apiKey,
      sessionName: args.sessionName,
      texto: `${resultado.question.answer}\n\nDecisão do dono.`,
      onWarn: (m) => deps.onInfo(m),
    })
    if (saiu) {
      await registrarResposta({
        prisma: deps.prisma,
        sessionName: args.sessionName,
        hashDaPergunta: marcarRespondida(args.hashDaPergunta),
        agora: new Date(),
      })
    }
    return
  }

  // Pergunta NOVA de verdade criada — marca ESCALADA (nunca "respondida":
  // ninguém respondeu ainda, é o dono quem vai decidir; a resposta dele
  // RETOMA a sessão em `retomar-sessao-com-resposta.ts`). Gravada só AQUI,
  // depois que a pergunta já existe — nunca antes.
  await registrarEscalada({
    prisma: deps.prisma,
    sessionName: args.sessionName,
    hashDaPergunta: args.hashDaPergunta,
    agora: new Date(),
  })
}
