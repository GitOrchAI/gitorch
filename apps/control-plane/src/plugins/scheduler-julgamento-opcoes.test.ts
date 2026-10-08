import { describe, expect, test, vi, type Mock } from 'vitest'
import { montarOpcoesDoJulgamento, type PrismaDoJulgamento } from './scheduler.js'
import type { PrismaDevSession } from '../services/dev-session-store.js'
import { SALA_DO_ENTENDIMENTO, type MissionMemory } from '../services/mission-context.js'

// Achado 1 (Crítico) da revisão da Tarefa 7: `registrarPendencia`,
// `limparPendencia` e `avisarDono` foram ADICIONADAS à interface de
// `runQaMissionViaRails`, mas o call site real em `executeMissionWithFailover`
// (fechamento não exportado) nunca as passava. Em produção: `pending_since`
// nunca era gravado, o teto de 90min nunca amadurecia, e o dono nunca era
// avisado de uma verificação parada — a lógica ficava correta e 100% testada
// em isolamento (qa-rails-mission.test.ts) e inerte na esteira de verdade.
//
// Achado crítico da revisão da Tarefa 10: `registrarFracassoDeMerge` repetiu
// o MESMO furo — adicionada à interface, nunca chegava a este ponto de
// disparo. `mergeFailures` lido do banco ficava sempre 0, o teto de 3
// tentativas nunca disparava, e a entrega era retentada contra o GitHub a
// cada tique do scheduler, para sempre.
//
// `montarOpcoesDoJulgamento` (extraída pelo mesmo motivo de
// `montarOpcoesDeDelegacao`, achado 2 da Tarefa 5 — ver
// scheduler-teto-delegacao.test.ts) é o que o call site agora espalha
// (`...montarOpcoesDoJulgamento(...)`) dentro do objeto passado a
// `runQaMissionViaRails`. Este arquivo prova que a função devolve as QUATRO
// opções ligadas ao Prisma de VERDADE (não stubs) e que `avisarDono` some do
// objeto (não fica presente com `undefined`) quando nenhum notificador foi
// construído — mesma disciplina de `...(notify ? { avisarDono: notify } : {})`
// já usada em `varrerSessoesDoDev` (scheduler.ts:~2248).
//
// Guarda estrutural pós-Tarefa 10 (para a classe do defeito não se repetir
// uma TERCEIRA vez): `montarOpcoesDoJulgamento` agora declara seu retorno como
// `Required<Omit<VigiliaDoJulgamentoOptions, 'avisarDono'>> & ...` — tipo
// DERIVADO da interface `VigiliaDoJulgamentoOptions` (qa-rails-mission.ts),
// não uma lista de nomes copiada à mão aqui ou lá. Um campo novo adicionado
// àquela interface fica automaticamente OBRIGATÓRIO no retorno desta função;
// esquecer de devolvê-lo quebra `pnpm --filter @gitorch/control-plane build`
// (erro de tipo "Property is missing"), antes mesmo dos testes rodarem — o
// mesmo esquecimento que passou por 2 revisões inteiras (Tarefas 7 e 10)
// sem o compilador reclamar nada, porque a opção era só OPCIONAL demais.
function prismaFalso(fichaDoPr: unknown = null) {
  return {
    devSession: {
      upsert: vi.fn(async (_args: unknown) => undefined),
      update: vi.fn(async (_args: unknown) => undefined),
      updateMany: vi.fn(async (_args: unknown) => undefined),
      findMany: vi.fn(async (_args: unknown) => []),
    },
    // O histórico de julgamentos do projeto vive em `event` (ver
    // historico-de-julgamento.ts).
    event: {
      create: vi.fn(async (_args: unknown) => undefined),
      findMany: vi.fn(async (_args: unknown) => []),
    },
    // A trava do parecer (trava-de-parecer.ts) vive na ficha do PR.
    repoItem: {
      upsert: vi.fn(async (_args: unknown) => undefined),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      // A ficha do PR (lida para saber se o entendimento mudou).
      findUnique: vi.fn(async (_args: unknown) => fichaDoPr),
    },
  } as unknown as PrismaDoJulgamento
}

/** O Cortex em memória: guarda o que é gravado, por id, como o real. */
function cortexFalso() {
  const gavetas = new Map<string, Parameters<MissionMemory['writeDrawer']>[0]>()
  const cortex: MissionMemory = {
    recallLocal: () => [],
    getDrawerById: (id) => gavetas.get(id) ?? null,
    writeDrawer: vi.fn(async (g) => {
      gavetas.set(g.id, g)
    }),
  }
  return { cortex, gavetas }
}

/** O `event` do fake, para conferir o que foi de fato gravado/lido. */
function eventoDe(prisma: PrismaDevSession) {
  return (prisma as unknown as { event: { create: Mock; findMany: Mock } }).event
}

describe('montarOpcoesDoJulgamento', () => {
  test('registrarPendencia devolvido chama updateMany no Prisma real (não um stub desconectado)', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_1',
    })

    const agora = new Date('2026-01-01T00:00:00.000Z')
    // As quatro funções são sempre devolvidas (só `avisarDono` é condicional)
    // — o `?` na assinatura vem só do formato que `VigiliaDoJulgamentoOptions`
    // declara (opcional PARA QUEM CHAMA `runQaMissionViaRails`), não de
    // `montarOpcoesDoJulgamento` já não as devolver.
    expect(opcoes.registrarPendencia).toBeDefined()
    await opcoes.registrarPendencia!({ sessionName: 'sessions/abc', agora })

    // Prova que a função devolvida É `registrarPendencia` de
    // dev-session-store.ts (mesmo `where: { pendingSince: null }` do achado
    // 3), não uma cópia solta que só parece certa.
    expect(prisma.devSession.updateMany).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/abc', pendingSince: null },
      data: { pendingSince: agora },
    })
  })

  test('limparPendencia devolvido chama update no Prisma real', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_1',
    })

    expect(opcoes.limparPendencia).toBeDefined()
    await opcoes.limparPendencia!({ sessionName: 'sessions/abc' })

    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/abc' },
      data: { pendingSince: null },
    })
  })

  test('registrarAvisoDeDemora devolvido chama update no Prisma real', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_1',
    })

    expect(opcoes.registrarAvisoDeDemora).toBeDefined()
    await opcoes.registrarAvisoDeDemora!({ sessionName: 'sessions/abc', hash: 'h1' })

    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/abc' },
      data: { answeredHash: 'h1' },
    })
  })

  // Achado crítico da revisão da Tarefa 10: esta opção existia na interface
  // (`QaRailsMissionOptions`/`VigiliaDoJulgamentoOptions`), tinha lógica
  // correta e testada em `qa-rails-mission.test.ts`, e `registrarPr`,
  // `registrarPendencia` etc. já provavam o padrão — mas
  // `montarOpcoesDoJulgamento` nunca a devolvia. Este teste é o que teria
  // pegado o furo antes do merge.
  test('registrarFracassoDeMerge devolvido chama update no Prisma real (não um stub desconectado)', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_1',
    })

    const agora = new Date('2026-01-01T00:00:00.000Z')
    expect(opcoes.registrarFracassoDeMerge).toBeDefined()
    await opcoes.registrarFracassoDeMerge!({ sessionName: 'sessions/abc', contador: 2, agora })

    // Prova que a função devolvida É `registrarFracassoDeMerge` de
    // dev-session-store.ts (mesmo `mergeFailures`/`mergeLastFailedAt` da
    // Tarefa 10), não uma cópia solta que só parece certa.
    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/abc' },
      data: { mergeFailures: 2, mergeLastFailedAt: agora },
    })
  })

  // A guarda estrutural `Required<Omit<...>>` obriga a propriedade a EXISTIR,
  // não a estar ligada à função certa com os argumentos certos. É essa
  // diferença que já deixou a lógica "correta, testada em isolamento e inerte
  // na esteira" duas vezes neste arquivo.
  test('registrarJulgamento devolvido grava o evento no PROJETO recebido', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_do_cliente_a',
    })

    expect(opcoes.registrarJulgamento).toBeDefined()
    await opcoes.registrarJulgamento!({ repositorio: 'acme/api', peloPortao: true })

    // O `projectId` vem de QUEM CHAMA, nunca de uma busca por endereço:
    // `wingId` não é único global, e dois clientes podem cadastrar `acme/api`.
    expect(eventoDe(prisma).create).toHaveBeenCalledWith({
      data: {
        projectId: 'proj_do_cliente_a',
        type: 'qa_judgment',
        payload: { peloPortao: true },
      },
    })
  })

  test('registrarJulgamento leva peloPortao=false sem inverter', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_1',
    })
    await opcoes.registrarJulgamento!({ repositorio: 'acme/api', peloPortao: false })

    expect(eventoDe(prisma).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: { peloPortao: false } }),
      })
    )
  })

  test('lerHistoricoDoProjeto devolvido lê SÓ o projeto recebido', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_do_cliente_a',
    })

    expect(opcoes.lerHistoricoDoProjeto).toBeDefined()
    await opcoes.lerHistoricoDoProjeto!('acme/api')

    // O endereço do repositório NÃO entra no filtro: se entrasse, o histórico
    // de um cliente cairia na conta do outro no mesmo repositório.
    expect(eventoDe(prisma).findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'proj_do_cliente_a', type: 'qa_judgment' },
        orderBy: { createdAt: 'desc' },
      })
    )
  })

  // A trava do parecer existia no módulo e em `qa-rails-mission.ts`, mas só
  // valia se o chamador passasse `prisma`/`projectId` soltos, e o scheduler
  // nunca passou: em produção, nenhuma ficha chegou a receber a trava. Estes
  // testes provam que a função devolve os ganchos ligados ao banco E ao projeto
  // desta iteração.
  test('adquirirTrava devolvido disputa a trava da ficha do PR no PROJETO recebido', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_do_cliente_a',
    })

    expect(await opcoes.adquirirTrava({ numeroDoPr: 42, headSha: 'abc123' })).toBe(true)

    expect(prisma.repoItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_tipo_numero: { projectId: 'proj_do_cliente_a', tipo: 'pr', numero: 42 },
        },
      })
    )
    expect(prisma.repoItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'proj_do_cliente_a', tipo: 'pr', numero: 42 }),
        data: expect.objectContaining({ parecerTravaHeadSha: 'abc123' }),
      })
    )
  })

  test('adquirirTrava devolve false quando o banco diz que outra missão já tomou o commit', async () => {
    const prisma = prismaFalso()
    vi.mocked(prisma.repoItem.updateMany).mockResolvedValueOnce({ count: 0 })
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_1',
    })

    expect(await opcoes.adquirirTrava({ numeroDoPr: 42, headSha: 'abc123' })).toBe(false)
  })

  test('liberarTrava devolvido zera a validade só do commit informado, no projeto recebido', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_do_cliente_a',
    })

    await opcoes.liberarTrava({ numeroDoPr: 42, headSha: 'abc123' })

    expect(prisma.repoItem.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'proj_do_cliente_a',
        tipo: 'pr',
        numero: 42,
        parecerTravaHeadSha: 'abc123',
      },
      data: { parecerTravadoAte: null },
    })
  })

  test('assentarTrava devolvido encurta a validade só do commit informado, no projeto recebido', async () => {
    const prisma = prismaFalso()
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma,
      projectId: 'proj_do_cliente_a',
    })
    const antes = Date.now()

    await opcoes.assentarTrava({ numeroDoPr: 42, headSha: 'abc123' })

    const chamada = vi.mocked(prisma.repoItem.updateMany).mock.calls[0]?.[0] as {
      where: unknown
      data: { parecerTravadoAte: Date }
    }
    expect(chamada.where).toEqual({
      projectId: 'proj_do_cliente_a',
      tipo: 'pr',
      numero: 42,
      parecerTravaHeadSha: 'abc123',
    })
    // A folga conta a partir de AGORA (a hora da publicação), não de quando a
    // trava foi tomada.
    const ate = chamada.data.parecerTravadoAte.getTime()
    expect(ate).toBeGreaterThanOrEqual(antes + 3 * 60_000)
    expect(ate).toBeLessThanOrEqual(Date.now() + 3 * 60_000)
  })

  // O entendimento do pedido entra pelo gancho `registrarEntendimento` (e não
  // por `prisma`/`projectId` soltos em `runQaMissionViaRails`, que ligariam o
  // grafo de vínculos no prompt do juiz). Sendo obrigatório no retorno desta
  // função, esquecer de ligá-lo quebra a build; estes testes provam que ele
  // está ligado à ficha do PR e ao Cortex do PROJETO recebido.
  const ENTENDIMENTO = {
    deOndeVeio: 'Jules pelo GitOrch',
    oQueMuda: 'ajusta o cache de sessão',
    queAjusteE: 'correção',
    porQueExiste: 'sessão expirava cedo demais',
  }

  test('registrarEntendimento devolvido grava o entendimento na ficha do PR, SEM `estado`, e a gaveta na sala própria', async () => {
    const prisma = prismaFalso()
    const { cortex, gavetas } = cortexFalso()
    const opcoes = montarOpcoesDoJulgamento({ prisma, cortex, projectId: 'proj_do_cliente_a' })

    expect(opcoes.registrarEntendimento).toBeDefined()
    await opcoes.registrarEntendimento!({
      numeroDoPr: 42,
      headSha: 'abc123',
      entendimento: ENTENDIMENTO,
    })

    const gravacao = vi.mocked(prisma.repoItem.upsert).mock.calls[0]?.[0] as {
      where: unknown
      update: Record<string, unknown>
    }
    expect(gravacao.where).toEqual({
      projectId_tipo_numero: { projectId: 'proj_do_cliente_a', tipo: 'pr', numero: 42 },
    })
    expect(gravacao.update).toEqual({ entendimento: ENTENDIMENTO })
    expect(gravacao.update).not.toHaveProperty('estado')

    expect([...gavetas.values()]).toEqual([
      expect.objectContaining({
        wingId: 'proj_do_cliente_a',
        roomId: SALA_DO_ENTENDIMENTO,
        id: 'entendimento:proj_do_cliente_a:42:abc123',
      }),
    ])
  })

  test('registrarEntendimento não regrava a ficha quando ela já tem o mesmo entendimento', async () => {
    const prisma = prismaFalso({ entendimento: ENTENDIMENTO })
    const { cortex } = cortexFalso()
    const opcoes = montarOpcoesDoJulgamento({ prisma, cortex, projectId: 'proj_1' })

    await opcoes.registrarEntendimento!({
      numeroDoPr: 42,
      headSha: 'abc123',
      entendimento: ENTENDIMENTO,
    })

    expect(prisma.repoItem.upsert).not.toHaveBeenCalled()
  })

  test('avisarDono presente no objeto devolvido quando um notificador foi construído', () => {
    const notify = vi.fn(async (_mensagem: string) => true)
    const opcoes = montarOpcoesDoJulgamento({
      prisma: prismaFalso(),
      cortex: cortexFalso().cortex,
      projectId: 'proj_1',
      avisarDono: notify,
    })

    expect(opcoes.avisarDono).toBe(notify)
  })

  test('avisarDono AUSENTE (não presente-com-undefined) sem notificador — mesma disciplina do resto do scheduler', () => {
    const opcoes = montarOpcoesDoJulgamento({
      cortex: cortexFalso().cortex,
      prisma: prismaFalso(),
      projectId: 'proj_1',
    })

    // `in` e não `toBeUndefined()`: a regressão que este teste pega é a
    // chave existir com valor `undefined` (o que `runQaMissionViaRails`
    // trata como "sem avisarDono" hoje, mas sob `exactOptionalPropertyTypes`
    // é uma forma diferente — e mais frágil — de expressar ausência do que
    // omitir a chave, o padrão que TODO o resto do scheduler segue).
    expect('avisarDono' in opcoes).toBe(false)
  })
})
