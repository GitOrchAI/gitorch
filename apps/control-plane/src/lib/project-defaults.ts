import type { PrismaClient } from '@prisma/client'

// Agenda padrão de um projeto novo (cron por agente). Um projeto sem agenda
// nunca é acionado pelo scheduler dirigido a dados, então todo projeto criado
// recebe estas entradas.
export const DEFAULT_SCHEDULES: ReadonlyArray<{ agentRole: string; cron: string }> = [
  { agentRole: 'ra', cron: '0 6,18 * * *' },
  { agentRole: 'po', cron: '0 3,15 * * *' },
  { agentRole: 'sm', cron: '0 5,11,17,23 * * *' },
  // O QA nasceu SEM agenda, e isso o deixava dependente de dois acasos: um
  // aviso de verificação concluída do GitHub, ou estar acompanhando uma
  // entrega ainda aberta. Um pull request cuja verificação terminou há dias e
  // cuja conversa com o dev já encerrou não tem quem chame o QA — foi assim
  // que entregas prontas ficaram paradas desde 09/08/2026, com verificação
  // verde, sem nenhum parecer. Observado ao vivo na virada de 21/08: teto
  // zerado, o relógio disparou ra e sm, e NENHUM qa.
  //
  // De 8 em 8 horas é o que `docs/agents/quality-assurance.md` §4.3 manda para
  // a auditoria de saúde do projeto. Horários escolhidos para não colidir com
  // os outros papéis (ra 6/18, po 3/15, sm 5/11/17/23): a colisão não quebra
  // nada, mas empurra a fila de concorrência sem motivo.
  { agentRole: 'qa', cron: '0 0,8,16 * * *' },
]

type PrismaLike = Pick<PrismaClient, 'projectSchedule'>

/**
 * Garante a agenda padrão de um projeto, por papel e idempotente: cria só o que
 * falta (uma criação parcial anterior não deixa o projeto sub-agendado).
 * lastTriggeredAt nasce em `now` para o primeiro disparo cair na PRÓXIMA janela
 * do cron, e não imediatamente ao subir.
 */
export async function ensureDefaultSchedules(
  prisma: PrismaLike,
  projectId: string,
  now: Date = new Date()
): Promise<number> {
  let created = 0
  for (const schedule of DEFAULT_SCHEDULES) {
    const existing = await prisma.projectSchedule.count({
      where: { projectId, agentRole: schedule.agentRole },
    })
    if (existing > 0) continue
    await prisma.projectSchedule.create({
      data: {
        projectId,
        agentRole: schedule.agentRole,
        cron: schedule.cron,
        lastTriggeredAt: now,
      },
    })
    created += 1
  }
  return created
}
