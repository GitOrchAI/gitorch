// DJ-T6b: dedupe do registro de auditoria na timeline do painel.
//
// ACHADO DA REVISÃO (DJ-T6): D76 tirou o dedupe que existia quando a
// escalada de retomada travada virava `agentQuestionService.ask`
// (deduplicado por `dedupKeyDeRetomada({repo, prNumber})`,
// `dedup-key-de-retomada.ts`) e a substituiu por
// `registrarEscaladaNoPainel` (`plugins/scheduler.ts`), que grava
// `app.prisma.event.create({ data: { projectId, type: 'audit', payload: {
// texto } } })` SEM checar se já existe um evento igual. Cada passada da
// esteira que decide "escalar" o MESMO PR cria outro registro idêntico na
// timeline (`GET /api/v1/painel/timeline`) — mesmo problema em potencial no
// registro de achado de automação (`registrarAchadoDeAutomacaoNoPainel`,
// `decisao-de-automacao.ts`), ainda que hoje o chamador só invoque uma vez
// por proposta nova.
//
// `registrarNoPainelUmaVez` é o ponto único: antes de gravar, consulta se já
// existe um evento `audit` do PROJETO com `payload.chave` igual — mesma
// sintaxe de filtro de campo JSON que `routes/painel.ts` já usa
// (`payload: { path: [...], equals: ... }`, também testada em
// `test/where-em-memoria.test.ts`). Achou → não grava de novo. A timeline
// continua lendo `payload.texto`; `payload.chave` é só o que este dedupe
// usa para reconhecer "já registrei isto".
//
// Chaves esperadas: `dedupKeyDeRetomada({repo, prNumber})`
// (`dedup-key-de-retomada.ts`) para retomada travada, e
// `dedupKeyDeAutomacao(repo, identidade)` (`decisao-de-automacao.ts`) para
// achado de automação — a MESMA identidade estável que já nomeia a pergunta
// ao dono nos outros fluxos, agora reaproveitada para nomear o evento de
// auditoria.

/** Só o que `registrarNoPainelUmaVez` precisa do Prisma. */
export interface PrismaDoRegistroNoPainel {
  event: {
    findFirst: (args: {
      where: { projectId: string; type: 'audit'; payload: { path: ['chave']; equals: string } }
    }) => Promise<unknown>
    create: (args: {
      data: { projectId: string; type: 'audit'; payload: { texto: string; chave: string } }
    }) => Promise<unknown>
  }
}

export interface RegistrarNoPainelUmaVezArgs {
  prisma: PrismaDoRegistroNoPainel
  projectId: string
  /** Identidade estável do fato — `dedupKeyDeRetomada`/`dedupKeyDeAutomacao`. */
  chave: string
  /** Vai para `payload.texto` — o que a timeline do painel renderiza. */
  texto: string
}

/**
 * Grava um evento `type: 'audit'` na timeline do painel, uma ÚNICA vez por
 * `chave` — chamadas repetidas com a mesma `chave` são um no-op depois da
 * primeira. `payload` carrega `{ texto, chave }`: a timeline lê `texto`
 * como sempre, e `chave` é só o campo que este dedupe consulta antes de
 * gravar de novo.
 */
export async function registrarNoPainelUmaVez(args: RegistrarNoPainelUmaVezArgs): Promise<void> {
  const jaExiste = await args.prisma.event.findFirst({
    where: {
      projectId: args.projectId,
      type: 'audit',
      payload: { path: ['chave'], equals: args.chave },
    },
  })
  if (jaExiste) return

  await args.prisma.event.create({
    data: {
      projectId: args.projectId,
      type: 'audit',
      payload: { texto: args.texto, chave: args.chave },
    },
  })
}
