import type { AgentQuestionRecord } from './agent-question.js'

/**
 * C2 (fix-up 3, task a13a42f8-2953-4259-b41f-3f8cddb304cd).
 *
 * `AgentQuestionService.marcarAssumida` recebe um `questionId` — mas quem
 * chama a partir da suposição do RA (`scheduler.ts`, dentro da wiring de
 * `suporDuvidaPendente`) só tem o par `(projectId, dedupKey)` (o hash da
 * marca `escalada:`, não o id da linha). Antes desta extração, a busca do
 * `questionId` a partir do dedupKey era um `findFirst` solto dentro do
 * scheduler, SEM `orderBy` e sem filtrar por `status`:
 *
 *   const question = await app.prisma.agentQuestion.findFirst({
 *     where: { projectId, dedupKey },
 *   })
 *
 * Uma escalada (`escalar-duvida-ao-dono.ts`) e uma reconciliação
 * (`reconciliar-duvidas-escaladas.ts`) podem gravar mais de uma
 * `agent_question` com o MESMO dedupKey ao longo do tempo — sem `orderBy`, a
 * ordem devolvida pelo banco não é garantida, e o `findFirst` podia pegar
 * uma linha ANTIGA (já `answered`/`assumida`) em vez da que ainda está
 * aberta esperando decisão. E o retorno de `perguntador.marcarAssumida(...)`
 * nunca era checado: se ele devolvesse `null` (a pergunta some entre o
 * `findFirst` e o `findUnique` interno — uma corrida rara, mas possível), a
 * promessa resolvia como SUCESSO e nada tinha sido gravado — silêncio total.
 *
 * Esta função fecha as duas lacunas:
 *  1. Escolhe a pergunta ABERTA mais recente para `(projectId, dedupKey)`
 *     (`status: 'open'`, `orderBy: { createdAt: 'desc' }`) — é essa que
 *     ainda espera decisão; uma linha já respondida/assumida nunca é
 *     escolhida de novo.
 *  2. Nenhuma pergunta aberta encontrada, OU `marcarAssumida` devolve `null`
 *     (a corrida rara acima) → LANÇA, nunca devolve silenciosamente. Quem
 *     chama (`supor-duvida-pendente.ts`, via `deps.marcarAssumida(...).catch
 *     (err => deps.onWarn(...))`) é quem decide o que fazer com o erro — a
 *     suposição já foi entregue ao dev quando isto roda, então uma falha
 *     aqui não desfaz a entrega, só fica menos rastreável (documentado em
 *     `supor-duvida-pendente.ts`).
 */

export interface PrismaParaMarcarAssumidaPorDedupKey {
  agentQuestion: {
    findFirst: (args: {
      where: { projectId: string; dedupKey: string; status: 'open' }
      orderBy: { createdAt: 'desc' }
    }) => Promise<{ id: string } | null>
  }
}

export interface DepsDeMarcarAssumidaPorDedupKey {
  prisma: PrismaParaMarcarAssumidaPorDedupKey
  /** `AgentQuestionService.marcarAssumida`, já vinculado à instância real. */
  marcarAssumida: (questionId: string, suposicao: string) => Promise<AgentQuestionRecord | null>
}

export async function marcarAssumidaPorDedupKey(
  args: { projectId: string; dedupKey: string; suposicao: string },
  deps: DepsDeMarcarAssumidaPorDedupKey
): Promise<void> {
  const question = await deps.prisma.agentQuestion.findFirst({
    where: { projectId: args.projectId, dedupKey: args.dedupKey, status: 'open' },
    orderBy: { createdAt: 'desc' },
  })
  if (!question) {
    throw new Error(`marcarAssumida: pergunta não encontrada para dedupKey ${args.dedupKey}`)
  }

  const marcada = await deps.marcarAssumida(question.id, args.suposicao)
  if (!marcada) {
    // Corrida rara: a linha existia no findFirst e sumiu (ou virou
    // answered/assumida por outra via) antes do findUnique interno de
    // `marcarAssumida`. NUNCA finge sucesso.
    throw new Error(`marcarAssumida: pergunta não encontrada para dedupKey ${args.dedupKey}`)
  }
}
