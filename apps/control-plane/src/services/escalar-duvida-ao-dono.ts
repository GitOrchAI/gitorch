import type { DestinoDaDuvida } from './duvida-do-dev.js'
import {
  atividadesDeConversaJules as atividadesDeConversaJulesReal,
  type AtividadeDaConversaJules,
} from './jules-client.js'
import { registrarConversaDaSessao, type PrismaCatalogoDeDuvidas } from './catalogo-de-duvidas.js'

export interface PrismaParaEscalarDuvida extends PrismaCatalogoDeDuvidas {}

export interface DepsDeEscalarDuvida {
  prisma: PrismaParaEscalarDuvida
  /** Injetável para teste; produção passa `atividadesDeConversaJules` de
   *  verdade (jules-client.ts) — fala com a rede, por isso é o único ponto
   *  substituível aqui (mesmo raciocínio de `responderSessaoJules` no
   *  módulo anterior a esta reescrita). */
  buscarConversa?: typeof atividadesDeConversaJulesReal
  onInfo: (mensagem: string) => void
  /**
   * D75 (05/09, decisão do dono): dúvida do dev NUNCA MAIS vira pergunta ao
   * dono. `onError` é o ÚNICO desfecho desta função quando QA/RA/PO não
   * resolveram — SEMPRE chamado, nunca silêncio (mesma lei de "nunca
   * mascarar" do resto do produto), e nunca seguido de `throw`: isto não é
   * uma falha de operação (banco fora do ar, dependência ausente), é o
   * NOVO COMPORTAMENTO NORMAL — a sessão espera, e o time (não o dono) tem
   * de resolver ou aprender a planejar melhor.
   */
  onError: (err: unknown, mensagem: string) => void
}

/**
 * Fecha o caminho da dúvida do dev até o dono — D75 (05/09), palavras do
 * dono: "os agentes do gitorch nao podem mandar essas duvidas pra mim, o
 * jules (DEV assincrono) eles (QA, SM, PO e RA) algum deles tem que
 * resolver isso, responder o jules. E não passar por mim, se o dev
 * assincrono tem duvidas, é pq foi mal planejado la atras com o PO e RA."
 *
 * ATÉ L5-T5, esta função SEMPRE criava uma `agent_question` de verdade
 * (`agentQuestionService.ask(...)`) quando QA/RA não sabiam responder — era
 * literalmente "escale a dúvida do dev ao dono". A reescrita inverte o
 * contrato por completo:
 *
 *  1. Best-effort: guarda a conversa desta sessão (pergunta do dev +
 *     resposta que o time já deu, via `atividadesDeConversaJules`) no
 *     catálogo (`catalogo-de-duvidas.ts`) — é o que alimenta a tarefa
 *     seguinte (RA/PO aprenderem com o histórico; fora do escopo desta).
 *     Uma falha aqui (rede do Jules, banco fora do ar) NUNCA pode impedir o
 *     passo 2: é enriquecimento, não o fato principal.
 *  2. SEMPRE registra a falha do TIME via `onError` — nunca cria
 *     `agent_question`, nunca lança. A sessão fica exatamente como está
 *     (nenhuma mensagem é mandada ao dev, nenhuma marca de estado é
 *     escrita): ela ESPERA. O mecanismo de retentativa/abandono que já
 *     existe (`decidirSobreAPergunta`, `pergunta-sem-resposta.ts`, chamado
 *     por quem invoca esta função) segue cuidando de quando desistir — este
 *     módulo não duplica esse controle.
 */
export async function escalarDuvidaAoDono(
  args: {
    destino: DestinoDaDuvida
    sessionName: string
    issueNumber: number
    repository: string
    projectId: string
    hashDaPergunta: string
    /** A pergunta original do dev — entra no relato da falha do time, para
     *  quem lê o log ter o contexto sem precisar ir atrás. */
    pergunta: string
    /** A chave do dev assíncrono desta sessão — usada só para buscar a
     *  conversa (passo 1, best-effort). */
    apiKey: string | undefined
  },
  deps: DepsDeEscalarDuvida
): Promise<void> {
  const motivo =
    args.destino.tipo === 'perguntar-ao-dono' ? args.destino.motivo : 'sem resposta útil'

  // Passo 1 (best-effort): guarda a conversa da sessão no catálogo. Nunca
  // pode impedir o passo 2 — é enriquecimento (para a tarefa seguinte),
  // nunca o fato principal (a falha do time, abaixo).
  try {
    const buscarConversa = deps.buscarConversa ?? atividadesDeConversaJulesReal
    const conversa: AtividadeDaConversaJules[] = await buscarConversa({
      apiKey: args.apiKey,
      sessionName: args.sessionName,
      onWarn: (m) => deps.onInfo(m),
    })
    await registrarConversaDaSessao({
      prisma: deps.prisma,
      projectId: args.projectId,
      sessionName: args.sessionName,
      issueNumber: args.issueNumber,
      atividades: conversa,
    })
  } catch (err) {
    deps.onInfo(
      `escalarDuvidaAoDono: não deu para catalogar a conversa da tarefa #${args.issueNumber} de ` +
        `${args.repository} (sessão ${args.sessionName}): ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
  }

  // Passo 2 (sempre): a decisão do dono (D75) fechou o caminho — dúvida do
  // dev NUNCA vira pergunta ao dono. Isto é FALHA DO TIME (planejamento
  // malfeito lá atrás, nas palavras do dono), registrada aqui SEMPRE — nunca
  // silêncio, nunca `agent_question`. A sessão espera; nada mais é feito.
  const perguntaResumida = args.pergunta.replace(/\s+/g, ' ').trim().slice(0, 200)
  const mensagem =
    `falha do time: nenhum papel (QA/RA/PO) conseguiu responder a dúvida do dev na tarefa ` +
    `#${args.issueNumber} de ${args.repository} (${motivo}) — pergunta: "${perguntaResumida}". ` +
    `D75 (05/09): isto NUNCA vira pergunta ao dono; a sessão ${args.sessionName} espera, e o ` +
    `time precisa resolver ou aprender a planejar melhor a próxima`
  deps.onError(new Error(mensagem), mensagem)
}
