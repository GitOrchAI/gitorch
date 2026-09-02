import { isF6AgentRole, type F6AgentRole } from '@gitorch/agents'
import { PROXIMO_PAPEL, type VezNaFila } from './passar-o-bastao.js'

/**
 * D16 (01/09/2026): a fila de passagem de bastão entre papéis
 * (passar-o-bastao.ts) vive num `Set` em memória — criado UMA VEZ no
 * registro do plugin e nunca escrito no banco. Um restart do control-plane
 * no meio de um handoff apaga a fila inteira; o papel seguinte, com o
 * trabalho já PRONTO, só roda no próximo horário de cron — medido em
 * produção, até 9 HORAS de espera (RA às 06h/18h, PO às 03h/15h). Em 30h de
 * produção real: 6 missões mortas como "Órfã de restart" porque a vez que
 * substituiria o cron nunca sobreviveu ao processo morrer.
 *
 * Este módulo é a METADE PERSISTIDA do mesmo desenho. `passagemDeBastao`
 * (em memória, em scheduler.ts) continua sendo a fonte de verdade DENTRO da
 * vida de um processo — nada aqui a substitui. `VezPendente` é só o espelho
 * durável: gravado no MESMO instante em que `passagemDeBastao.passar()`
 * enfileira em memória (ver o handler de missão completada em scheduler.ts),
 * apagado quando a vez é honrada (disparou, com sucesso ou falha
 * DEFINITIVA), e lido de novo no boot do processo seguinte para retomar sem
 * esperar cron nem tique.
 *
 * TABELA PRÓPRIA em vez de reaproveitar `ProjectSchedule` ou `Mission`
 * (decisão da fase de design, ver PR): `ProjectSchedule` filtra por
 * `isActive` na leitura do tique — um dono que desliga o cron de um papel
 * esconderia a vez pendente do mesmo papel para sempre; e passaria a
 * carregar um contador de tentativas de RESTART que não tem nada a ver com
 * "quando este cron dispara". `Mission` só nasce DEPOIS de concorrência e
 * teto diário passarem — uma vez pendente que ainda não tentou nada não é
 * uma Mission pela própria definição do código, e encaixá-la ali obrigaria
 * mais uma exceção na aritmética de teto que o próprio scheduler.ts já
 * documenta como fácil de errar.
 */

/**
 * Só o que este módulo usa do Prisma — permite injetar um fake nos testes.
 *
 * Assinatura de MÉTODO (`upsert(args: unknown): ...`), não propriedade de
 * função (`upsert: (args: unknown) => ...`): com `strictFunctionTypes`
 * ligado (tsconfig deste projeto), propriedade de função é checada por
 * contravariância — o PrismaClient real (métodos com args tipados) deixaria
 * de ser atribuível aqui, e todo call site precisaria de `as unknown as`
 * (ver PrismaDoHistorico em historico-de-julgamento.ts). Assinatura de
 * método é bivariante por desenho do TypeScript — mesmo padrão de
 * boot-reaper.ts (`updateMany(args: unknown): ...`), sem cast nenhum.
 */
export interface PrismaDaVezPendente {
  vezPendente: {
    upsert(args: unknown): Promise<unknown>
    deleteMany(args: unknown): Promise<{ count: number }>
    findMany(args: unknown): Promise<VezPendenteRow[]>
    update(args: unknown): Promise<{ tentativas: number }>
  }
  event: {
    create(args: unknown): Promise<unknown>
  }
}

export interface VezPendenteRow {
  id: string
  projectId: string
  agentRole: string
  tentativas: number
}

/** Só o que este módulo usa do logger — mesmo padrão de boot-reaper.ts. */
export interface LogLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Grava (ou confirma) que `papelQueTerminou` deixou trabalho pronto para o
 * seguinte, no MESMO vocabulário de `PROXIMO_PAPEL` que `passagemDeBastao`
 * já usa em memória — nunca duas fontes de verdade sobre quem vem depois de
 * quem. Papel sem seguinte (sm, qa) não escreve nada, pela mesma razão que
 * `passar()` não enfileira nada para eles.
 *
 * `update: {}` de propósito: se a linha já existe (o papel terminou duas
 * vezes antes do seguinte rodar — o mesmo caso que o `Set` em memória já
 * deduplica pela chave), o upsert não mexe em `tentativas`. Resetar o
 * contador aqui destruiria exatamente a informação que impede o laço
 * infinito de retomada no boot (ver `retomarVezesPendentesNoBoot`).
 */
export async function registrarBastaoPendente(
  prisma: PrismaDaVezPendente,
  papelQueTerminou: F6AgentRole,
  projectId: string
): Promise<void> {
  const seguinte = PROXIMO_PAPEL[papelQueTerminou]
  if (!seguinte) return
  await prisma.vezPendente.upsert({
    where: { projectId_agentRole: { projectId, agentRole: seguinte } },
    create: { projectId, agentRole: seguinte },
    update: {},
  })
}

/**
 * A vez foi HONRADA — disparou de verdade, com sucesso ou com uma falha
 * DEFINITIVA (não um "estou ocupado agora"). A linha não precisa mais
 * sobreviver a um restart, porque não há mais nada pendente para retomar.
 */
export async function removerBastaoPendente(
  prisma: PrismaDaVezPendente,
  papel: F6AgentRole,
  projectId: string
): Promise<void> {
  await prisma.vezPendente.deleteMany({
    where: { projectId, agentRole: papel },
  })
}

/**
 * Teto de quantos BOOTS retomam a MESMA vez pendente antes de desistir.
 *
 * Conta boots, não recusas: uma recusa temporária ("busy") dentro do mesmo
 * processo já é resolvida pela fila em memória / próximo tique, sem gastar
 * teto nenhum daqui (ver `retomarVezesPendentesNoBoot`: só o `update` de
 * `tentativas` roda antes do disparo de boot, uma vez por subida). 5 boots é
 * generoso o bastante para sobreviver a uma sequência de deploys ruins do
 * mesmo dia, e pequeno o bastante para nunca reinsistir para sempre num
 * papel genuinamente quebrado (ex.: migração faltando, bug que crasha o
 * processo assim que aquele papel roda) — item 5 do desenho: "papel que
 * falha sempre não pode ser re-disparado infinitamente a cada boot".
 */
export const TENTATIVAS_MAX_NO_BOOT = 5

export const TIPO_EVENTO_VEZ_PENDENTE_ABANDONADA = 'vez_pendente_abandonada'

/** O que `retomarVezesPendentesNoBoot` chama para efetivamente disparar. */
export type DisparoDeRetomada = (
  papel: F6AgentRole,
  projectId: string
) => Promise<{ triggered: boolean; reason?: string }>

/**
 * NO BOOT, retoma: lê toda vez pendente persistida e dispara o papel
 * seguinte IMEDIATAMENTE — sem esperar o próximo tique nem o cron do papel.
 * É a PROVA do D16: o trabalho que um restart deixaria preso por até 9 horas
 * volta a andar na subida do próprio processo que causou a perda.
 *
 * IDEMPOTÊNCIA: cada linha é por `(projectId, agentRole)` — a mesma garantia
 * de chave única que o `Set` em memória já tinha, então nunca dispara duas
 * vezes o mesmo papel para o mesmo projeto por esta varredura.
 *
 * CONVERSA COM O CEIFADOR (boot-reaper.ts): o ceifador marca a missão órfã
 * como `failed` — nunca a retoma. Este é o retomador: dispara o PAPEL de
 * novo (via `disparar`, o mesmo `triggerAgentMission` de sempre), não a
 * missão morta — decisão da fase de design: uma missão nova passa pelos
 * MESMOS tetos de concorrência/orçamento de qualquer disparo real, em vez de
 * inventar uma exceção nova na aritmética de teto (que o próprio
 * scheduler.ts já documenta como fácil de errar). Se a missão órfã ainda não
 * foi marcada `failed` quando isto roda (os dois são fire-and-forget,
 * independentes), o pior caso é o teto de concorrência recusar como 'busy'
 * — motivo RETRYABLE — e a vez volta para a fila em memória; o tique
 * seguinte (60s depois, bem antes do ceifador terminar de qualquer forma)
 * tenta de novo. Nunca perde a vez por causa da corrida.
 */
export async function retomarVezesPendentesNoBoot(
  prisma: PrismaDaVezPendente,
  log: LogLike,
  disparar: DisparoDeRetomada,
  devolverNaFilaEmMemoria: (vez: VezNaFila) => void,
  retryableReasons: ReadonlySet<string>
): Promise<void> {
  let pendentes: VezPendenteRow[]
  try {
    pendentes = await prisma.vezPendente.findMany({})
  } catch (err) {
    log.error(err, '[VezPendente] falha ao ler vezes pendentes no boot; tenta no próximo restart')
    return
  }

  for (const row of pendentes) {
    if (!isF6AgentRole(row.agentRole)) {
      log.warn(`[VezPendente] linha ${row.id} com papel desconhecido '${row.agentRole}'; ignorando`)
      continue
    }
    const papel: F6AgentRole = row.agentRole

    if (row.tentativas >= TENTATIVAS_MAX_NO_BOOT) {
      // NUNCA CRIA LAÇO (item 5 do desenho): desiste, com o motivo escrito —
      // nunca silêncio. Event porque é só-anexa e é a mesma prateleira que o
      // resto do produto usa para trilha (ver historico-de-julgamento.ts).
      await prisma.event
        .create({
          data: {
            projectId: row.projectId,
            type: TIPO_EVENTO_VEZ_PENDENTE_ABANDONADA,
            payload: {
              papel,
              tentativas: row.tentativas,
              motivo: `esgotou ${TENTATIVAS_MAX_NO_BOOT} boot(s) sem confirmar o disparo`,
            },
          },
        })
        .catch((err: unknown) =>
          log.error(
            err,
            `[VezPendente] falha ao registrar desistência de ${papel} em ${row.projectId}`
          )
        )
      await prisma.vezPendente
        .deleteMany({ where: { id: row.id } })
        .catch((err: unknown) =>
          log.warn(err, `[VezPendente] falha ao limpar linha ${row.id} abandonada`)
        )
      log.error(
        `[VezPendente] ${papel} em ${row.projectId} desistiu após ${row.tentativas} tentativa(s) de boot`
      )
      continue
    }

    // Conta o BOOT, antes de saber o resultado — é a garantia de laço, não a
    // taxa de sucesso.
    await prisma.vezPendente.update({
      where: { id: row.id },
      data: { tentativas: { increment: 1 } },
    })

    const resultado = await disparar(papel, row.projectId).catch((err: unknown) => {
      log.error(err, `[VezPendente] disparo de retomada rejeitou para ${papel} em ${row.projectId}`)
      return { triggered: false, reason: 'error' }
    })

    if (!resultado.triggered && resultado.reason && retryableReasons.has(resultado.reason)) {
      devolverNaFilaEmMemoria({ papel, projectId: row.projectId })
      log.warn(
        `[VezPendente] ${papel} em ${row.projectId} recusado no boot (${resultado.reason}); ` +
          'volta para a fila em memória — o próximo tique tenta de novo'
      )
      continue
    }

    // Disparou OU falhou por motivo definitivo: a vez foi honrada.
    await prisma.vezPendente
      .deleteMany({ where: { id: row.id } })
      .catch((err: unknown) =>
        log.warn(err, `[VezPendente] falha ao limpar linha ${row.id} após disparo`)
      )
    if (resultado.triggered) {
      log.info(
        `[VezPendente] ${papel} em ${row.projectId} retomado sozinho na subida do control-plane`
      )
    }
  }
}
