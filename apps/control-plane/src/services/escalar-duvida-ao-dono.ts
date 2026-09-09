import type { AgentQuestionService, AskResult } from './agent-question.js'
import type { DestinoDaDuvida } from './duvida-do-dev.js'
import type { PrismaDevSession } from './dev-session-store.js'
import { registrarResposta, registrarEscalada } from './dev-session-store.js'
import { marcarRespondida } from './pergunta-sem-resposta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import { responderSessaoJules as responderSessaoJulesReal } from './jules-client.js'
import {
  perguntaExecutivaDeReserva,
  OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA,
} from './texto-de-escalada.js'
import {
  contextoExecutivoVazio,
  type ContextoExecutivoDaPergunta,
} from './contexto-executivo-da-pergunta.js'
import type { NotifiableProject } from './telegram-link.js'
import { dedupKeyDeDuvidaDoDev } from './dedup-key-de-duvida.js'

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
  /**
   * D73/L4-T23: monta as 4 peças da história executiva (ciclo, entrega,
   * decisões já tomadas, lacunas) para a pergunta de RESERVA contar a
   * história em vez de citar a dúvida técnica do dev — ver
   * `contexto-executivo-da-pergunta.ts`. `undefined` (nenhum dep
   * configurado) e qualquer falha aqui dentro caem para
   * `contextoExecutivoVazio()` — best-effort por contrato, MESMO princípio
   * de `notify` em `agent-question.ts`: uma falha ao ENRIQUECER a pergunta
   * nunca pode impedir a pergunta de NASCER (as lacunas entram no texto no
   * lugar do dado que faltou).
   */
  montarContexto?: (args: {
    issueNumber: number
    repository: string
    projectId: string
  }) => Promise<ContextoExecutivoDaPergunta>
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

/**
 * Completa as opções do MODELO até 3, usando a reserva determinística
 * (`OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA`) para preencher o que falta — nunca
 * duplica `value` nem `label`.
 *
 * Existe porque a checagem anterior (`opcoesDoModelo.length === 3`) jogava
 * fora o TEXTO INTEIRO de uma pergunta executiva boa só porque o modelo
 * trouxe 1 ou 2 opções em vez de 3 — o dono perdia a pergunta de verdade e
 * recebia a genérica de reserva por causa de uma opção faltando. D71/D72
 * continuam intactos: o resultado aqui é SEMPRE exatamente 3 opções (a 4ª,
 * "Outro", é sempre adicionada por quem chama `ask()` — nunca aqui).
 */
export function completarOpcoesAte3(
  opcoesDoModelo: Array<{ label: string; value: string }>
): Array<{ label: string; value: string }> {
  if (opcoesDoModelo.length >= 3) return opcoesDoModelo.slice(0, 3)
  const completas = [...opcoesDoModelo]
  for (const opcaoDeReserva of OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA) {
    if (completas.length >= 3) break
    const duplicada = completas.some(
      (o) => o.value === opcaoDeReserva.value || o.label === opcaoDeReserva.label
    )
    if (!duplicada) completas.push(opcaoDeReserva)
  }
  return completas
}

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
  // este campo, e o próprio QA pode deixá-lo vazio de propósito — usa a
  // pergunta EXECUTIVA de reserva (determinística, D72).
  const perguntaExecutivaDoModelo =
    args.destino.tipo === 'perguntar-ao-dono' ? args.destino.perguntaExecutiva : undefined
  // C2 (fix-up L4-T3): D71 é "3 objetivas + 1 aberta" — SEMPRE. Sem este
  // teto, um RA que devolvesse 4+ opções faria `ask()` juntar TODAS elas +
  // a opção livre, estourando o formato que o dono sempre pede.
  const opcoesDoModelo = (
    args.destino.tipo === 'perguntar-ao-dono' ? (args.destino.opcoes ?? []) : []
  ).slice(0, 3)
  // D72 (02/09): o dono flagrou ao vivo a pergunta CRUA do dev (em inglês)
  // chegando com um botão só. Correção pós-D72 (revisão): a checagem
  // anterior (`opcoesDoModelo.length === 3`) jogava fora o TEXTO INTEIRO do
  // modelo sempre que ele trazia 1 ou 2 opções concretas — uma pergunta
  // executiva boa virava a genérica de reserva só por faltar 1 opção. Agora:
  // confia no texto do modelo sempre que ele veio (`perguntaExecutivaDoModelo`)
  // junto de PELO MENOS 1 opção concreta, e COMPLETA até 3 com a reserva
  // (nunca duplica value/label — `completarOpcoesAte3`). Só cai para a
  // reserva INTEIRA (texto e opções) quando o modelo não trouxe texto
  // nenhum, ou trouxe 0 opções.
  const modeloTrouxeTraducaoValida = Boolean(perguntaExecutivaDoModelo) && opcoesDoModelo.length > 0
  let textoDaPergunta: string
  let opcoesReais: Array<{ label: string; value: string }>
  if (modeloTrouxeTraducaoValida) {
    textoDaPergunta = perguntaExecutivaDoModelo as string
    opcoesReais = completarOpcoesAte3(opcoesDoModelo)
  } else {
    // D73/L4-T23: a reserva agora CONTA A HISTÓRIA (ciclo, entrega, decisões
    // já tomadas) em vez de citar a dúvida técnica do dev — só busca o
    // contexto quando de fato vai usar a reserva (o modelo não trouxe
    // tradução válida); best-effort por contrato: uma falha aqui NUNCA pode
    // impedir a pergunta de nascer (contextoExecutivoVazio() entra no lugar,
    // com as lacunas declaradas no texto).
    let contexto: ContextoExecutivoDaPergunta
    if (deps.montarContexto) {
      try {
        contexto = await deps.montarContexto({
          issueNumber: args.issueNumber,
          repository: args.repository,
          projectId: args.projectId,
        })
      } catch (err) {
        deps.onInfo(
          `escalarDuvidaAoDono: não deu para montar o contexto executivo da tarefa ` +
            `#${args.issueNumber} de ${args.repository} — a pergunta segue com as lacunas ` +
            `declaradas: ${err instanceof Error ? err.message : String(err)}`
        )
        contexto = contextoExecutivoVazio()
      }
    } else {
      contexto = contextoExecutivoVazio()
    }
    const reserva = perguntaExecutivaDeReserva({
      issueNumber: args.issueNumber,
      repository: args.repository,
      contexto,
    })
    textoDaPergunta = reserva.text
    opcoesReais = reserva.options
  }
  // A2 (fix-up L4-T3): fonte ÚNICA do formato (dedup-key-de-duvida.ts) —
  // valida e lança cedo (nunca cria uma agent_question com dedupKey
  // quebrado que ninguém mais consegue casar de volta).
  let dedupKey: string
  try {
    dedupKey = dedupKeyDeDuvidaDoDev({
      repo: args.repository,
      issue: args.issueNumber,
      hash: args.hashDaPergunta,
    })
  } catch (err) {
    const mensagem =
      `escalarDuvidaAoDono: dedupKey inválido para a tarefa #${args.issueNumber} de ` +
      `${args.repository} — a pergunta NÃO nasceu: ${err instanceof Error ? err.message : String(err)}`
    deps.onError(err, mensagem)
    throw err
  }

  let resultado: AskResult
  try {
    resultado = await perguntador.ask(projeto.userId, args.projectId, {
      text: textoDaPergunta,
      context: `Tarefa #${args.issueNumber} de ${args.repository} — o dev assíncrono está parado esperando esta decisão.`,
      // Objetivas (o modelo) + a aberta (sempre presente, determinística):
      // "3 objetivas + 1 aberta" é o formato que o dono sempre pede (D71).
      options: [...opcoesReais, buildFreeTextOption()],
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
    //
    // C5 (fix-up L4-T3): `!resultado.question.answer` só barrava
    // `null`/`''` — uma resposta gravada como espaço em branco (`'   '`) é
    // truthy em JS e passava direto, entregando um TEXTO VAZIO ao dev.
    // Trata como dado corrompido: nunca entrega, erro ALTO (nunca silêncio)
    // — a mesma disciplina do resto desta função.
    const respostaAnterior = resultado.question.answer
    if (!respostaAnterior || !respostaAnterior.trim()) {
      const mensagem =
        `escalarDuvidaAoDono: a pergunta ${resultado.question.id} já está respondida mas com ` +
        `resposta vazia — não dá para retomar a sessão ${args.sessionName} com um texto vazio ` +
        `(tarefa #${args.issueNumber} de ${args.repository})`
      deps.onError(new Error(mensagem), mensagem)
      throw new Error(mensagem)
    }
    const responder = deps.responderSessaoJules ?? responderSessaoJulesReal
    const saiu = await responder({
      apiKey: args.apiKey,
      sessionName: args.sessionName,
      texto: `${respostaAnterior}\n\nDecisão do dono.`,
      onWarn: (m) => deps.onInfo(m),
    })
    if (!saiu) {
      // C5 (fix-up L4-T3): antes retornava em silêncio (a exceção não
      // subia) — a próxima acordada nem sabia que precisava tentar de
      // novo com urgência. Agora LANÇA, mesma disciplina de
      // `aoResponderDuvidaDoDev` (retomar-sessao-com-resposta.ts).
      const mensagem =
        `escalarDuvidaAoDono: não deu para entregar a resposta anterior à sessão ${args.sessionName} ` +
        `(tarefa #${args.issueNumber} de ${args.repository})`
      deps.onError(new Error(mensagem), mensagem)
      throw new Error(mensagem)
    }
    await registrarResposta({
      prisma: deps.prisma,
      sessionName: args.sessionName,
      hashDaPergunta: marcarRespondida(args.hashDaPergunta),
      agora: new Date(),
    })
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
