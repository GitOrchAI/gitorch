// A porta de ESCRITA única do catálogo de conversa do dev assíncrono (Jules)
// — L5-T5, decisão do dono D75 (05/09):
//
//   "os agentes do gitorch nao podem mandar essas duvidas pra mim, o jules
//   (DEV assincrono) eles (QA, SM, PO e RA) algum deles tem que resolver
//   isso, responder o jules. E não passar por mim [...] tem que ter sistema
//   que coleta todas essas duvidas pra que nas proximas tasks o RA e PO não
//   gere duvidas e sempre melhore".
//
// Guarda, por sessão/projeto/tarefa, cada pergunta do dev (`agentMessaged`,
// `atividadesDeConversaJules` em jules-client.ts) e cada resposta que O TIME
// deu (`userMessaged`) — nada aqui decide o que fazer com o catálogo depois
// (injetar no contexto do planejador/analista, tela de medição semanal): são
// tarefas seguintes, fora do escopo desta.

import { neutralizarTextoDeTerceiros } from './decisao-de-automacao.js'
import type { AtividadeDaConversaJules } from './jules-client.js'

/** O mínimo do client do Prisma que este módulo usa. */
export interface PrismaCatalogoDeDuvidas {
  catalogoDeDuvidas: {
    /**
     * `skipDuplicates: true` é o que torna a gravação IDEMPOTENTE: a mesma
     * sessão é relida a cada tique enquanto está esperando resposta, e sem
     * isto cada releitura duplicaria as mensagens já conhecidas. O índice
     * único de `(session_name, originator, momento)` (ver
     * prisma/catalogo-de-duvidas-migration.sql) é o que dá ao banco o que
     * comparar.
     */
    createMany: (args: {
      data: Array<{
        projectId: string
        sessionName: string
        issueNumber: number
        originator: string
        texto: string
        momento: Date
      }>
      skipDuplicates: boolean
    }) => Promise<{ count: number }>
  }
}

/**
 * Teto de caracteres por mensagem do catálogo — mesma disciplina de
 * `TETO_DE_CARACTERES_DA_RESPOSTA_DO_DONO`/`_LIVRE` (retomar-sessao-com-
 * resposta.ts / decisao-de-automacao.ts): nenhum texto de fora (fala do dev,
 * fala do time) entra sem corte. 4000 — o dobro do teto da resposta livre do
 * dono — porque aqui é a CONVERSA INTEIRA que pode incluir explicações
 * técnicas mais longas do dev, não só uma escolha entre opções.
 */
export const TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO = 4000

/**
 * Corta no teto e neutraliza menção/comando (`neutralizarTextoDeTerceiros`,
 * decisao-de-automacao.ts) — mesma defesa que o resto do produto já aplica a
 * texto de terceiro antes de guardar/publicar, para o dia em que este
 * catálogo virar superfície visível (Telegram/painel). NUNCA grava valor de
 * segredo — mas isso é responsabilidade de QUEM PRODUZ o texto (dev, QA, RA,
 * PO: nenhum deles deveria colar segredo numa mensagem de conversa); este
 * módulo só garante teto e neutralização, não detecção de segredo.
 */
export function sanitizarTextoDoCatalogo(texto: string): string {
  return neutralizarTextoDeTerceiros(texto, TETO_DE_CARACTERES_DA_MENSAGEM_DO_CATALOGO)
}

/**
 * Grava a conversa (pergunta do dev + resposta do time) desta sessão no
 * catálogo. Filtra texto vazio antes de gravar (não deveria chegar aqui —
 * `atividadesDeConversaJules` já filtra — mas defesa em profundidade é
 * barata). Lista vazia não chama o banco à toa.
 *
 * NUNCA mascara erro do banco: propaga a exceção — quem chama decide se o
 * catálogo é best-effort (não pode travar o fluxo principal) ou crítico.
 */
export async function registrarConversaDaSessao(deps: {
  prisma: PrismaCatalogoDeDuvidas
  projectId: string
  sessionName: string
  issueNumber: number
  atividades: AtividadeDaConversaJules[]
}): Promise<void> {
  const linhas = deps.atividades
    .filter((a) => a.texto.trim().length > 0)
    .map((a) => ({
      projectId: deps.projectId,
      sessionName: deps.sessionName,
      issueNumber: deps.issueNumber,
      originator: a.originator,
      texto: sanitizarTextoDoCatalogo(a.texto),
      momento: a.quando,
    }))
  if (linhas.length === 0) return
  await deps.prisma.catalogoDeDuvidas.createMany({ data: linhas, skipDuplicates: true })
}
