import type { PrismaClient } from '@prisma/client'

// Agenda padrão de um projeto novo (cron por agente). Um projeto sem agenda
// nunca é acionado pelo scheduler dirigido a dados, então todo projeto criado
// recebe estas entradas.
/**
 * O cron antigo do SM (4x/dia). DJ-T3 substituiu o padrão por um relógio de
 * 15 em 15 minutos — mas só o SM que ainda está NESTE valor exato migra (ver
 * `ensureDefaultSchedules` abaixo); um ajuste manual do dono não é pisado.
 */
export const CRON_ANTIGO_DO_SM = '0 5,11,17,23 * * *'

export const DEFAULT_SCHEDULES: ReadonlyArray<{ agentRole: string; cron: string }> = [
  { agentRole: 'ra', cron: '0 6,18 * * *' },
  { agentRole: 'po', cron: '0 3,15 * * *' },
  // DJ-T3: o SM agora também acorda por EVENTO (vaga liberada — ver
  // acordar-sm.ts), mas o relógio continua sendo a rede de segurança. 4x/dia
  // deixava até 6h de vaga livre sem ninguém preencher quando um evento se
  // perdia (restart, bug); 15 em 15 minutos é raro o bastante para não gastar
  // cota à toa (o SM é determinístico e um noOp não custa motor) e frequente
  // o bastante para nunca ser o gargalo.
  { agentRole: 'sm', cron: '*/15 * * * *' },
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
 *
 * DJ-T3: quem já tem a linha do SM migra para o novo padrão (a cada 15 min)
 * SÓ SE o cron gravado for EXATAMENTE o antigo (`CRON_ANTIGO_DO_SM`). Um
 * projeto onde o dono já mexeu na agenda (qualquer outro valor) não é
 * pisado — a função nunca sabe se um cron "diferente do antigo" é ajuste
 * manual ou já é o padrão novo, e o lado seguro é não tocar no que não
 * reconhece como o valor legado exato.
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
    if (existing > 0) {
      // DJ-T3: só o SM migra, e só quando o cron gravado é EXATAMENTE o
      // valor legado — uma consulta extra, só para este papel, só quando ele
      // já existe. Barato: um papel por projeto, não todos.
      if (schedule.agentRole === 'sm' && schedule.cron !== CRON_ANTIGO_DO_SM) {
        const linha = await prisma.projectSchedule.findFirst({
          where: { projectId, agentRole: 'sm' },
          select: { id: true, cron: true },
        })
        if (linha && linha.cron === CRON_ANTIGO_DO_SM) {
          await prisma.projectSchedule.update({
            where: { id: linha.id },
            data: { cron: schedule.cron },
          })
        }
      }
      continue
    }
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
