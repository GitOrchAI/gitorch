import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  suporDuvidaPendente,
  type DepsDeSuporDuvidaPendente,
  type PrismaParaSuporDuvidaPendente,
} from './supor-duvida-pendente.js'
import type { LinhaDeSessao } from './dev-session-store.js'

// L4-T4 (D64), fix-up da task a13a42f8-2953-4259-b41f-3f8cddb304cd.
//
// CAUSA RAIZ que este fix-up corrige: `suporSemODono` (duvida-rails-mission.ts)
// já existia, testado, mas em produção `deps.suporSemODono` nunca era
// fornecido a `session-watch.ts` — o único `execute: StepExecutor` real do
// produto nasce dentro de `executeMissionWithFailover` (scheduler.ts), e a
// vigia roda no seu PRÓPRIO `setInterval`, fora de qualquer missão. Todo
// tique caía sempre em "sem suposição concreta ao dono".
//
// O conserto: esta função roda DENTRO da mesma missão de QA que já responde
// dúvida pendente (`responderDuvidaPendente`), com o `execute` de verdade —
// extraída para cá (MESMO padrão de `escalar-duvida-ao-dono.ts`) para ser
// testável sem a máquina de missão/motor, usando um `execute` FALSO que
// exercita o `suporSemODono` real (schema, freio de concretude — nada disso
// é reimplementado aqui).

const agora = new Date('2026-01-01T12:00:00.000Z')

function hashDe(mensagem: string): string {
  return createHash('sha256').update(mensagem).digest('hex').slice(0, 16)
}

function linha(overrides: Partial<LinhaDeSessao> = {}): LinhaDeSessao {
  return {
    id: 'row1',
    projectId: 'proj1',
    issueNumber: 91,
    sessionName: 'sessions/escalada-1',
    state: 'AWAITING_USER_FEEDBACK',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: agora,
    stateCheckedAt: null,
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
    ...overrides,
  }
}

function prismaFalso(
  overrides: {
    candidatas?: LinhaDeSessao[]
    projeto?: { id: string; wingId: string; userId: string | null } | null
  } = {}
): PrismaParaSuporDuvidaPendente & {
  _updateCalls: Array<{ where: unknown; data: Record<string, unknown> }>
} {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  return {
    devSession: {
      findMany: vi.fn(async () => overrides.candidatas ?? []),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        return undefined
      }),
      upsert: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => undefined),
      findFirst: vi.fn(async () => null),
    },
    project: {
      findUnique: vi.fn(
        async () => overrides.projeto ?? { id: 'proj1', wingId: 'acme/api', userId: 'user1' }
      ),
    },
    _updateCalls: updateCalls,
  } as unknown as PrismaParaSuporDuvidaPendente & {
    _updateCalls: Array<{ where: unknown; data: Record<string, unknown> }>
  }
}

function depsFalso(
  overrides: Partial<DepsDeSuporDuvidaPendente> & {
    candidatas?: LinhaDeSessao[]
  } = {}
): DepsDeSuporDuvidaPendente {
  const { candidatas, ...rest } = overrides
  return {
    prisma: prismaFalso({ candidatas: candidatas ?? [] }),
    chaveDaSessao: vi.fn(async () => 'jules-key'),
    ultimaMensagem: vi.fn(async () => 'Devo usar bcrypt ou argon2 para o hash de senha?'),
    responder: vi.fn(async () => true),
    comentarNaIssue: vi.fn(async () => undefined),
    marcarAssumida: vi.fn(async () => undefined),
    avisarDono: vi.fn(async () => true),
    onWarn: vi.fn(),
    agora,
    ...rest,
  }
}

const ARGS_BASE = {
  projectId: 'proj1',
  repository: 'acme/api',
  contextBlocks: ['codegraph aqui'],
}

describe('suporDuvidaPendente (L4-T4, D64) — o tratador roda dentro da missão de QA', () => {
  it('sem candidatas: não toca em nada (nem project.findUnique)', async () => {
    const deps = depsFalso({ candidatas: [] })
    const execute = vi.fn(async () => '')

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    expect(execute).not.toHaveBeenCalled()
    expect(deps.prisma.project.findUnique).not.toHaveBeenCalled()
  })

  it('sessão sem marca escalada é ignorada (só olha para `escalada:`)', async () => {
    const mensagem = 'x?'
    const deps = depsFalso({
      candidatas: [linha({ answeredHash: `respondida:0:${hashDe(mensagem)}` })],
    })
    const execute = vi.fn(async () => '')

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    expect(execute).not.toHaveBeenCalled()
  })

  it('escalada mas AINDA dentro das 24h: NÃO forma suposição — o limiar é decidido aqui, não na vigia', async () => {
    const mensagem = 'Isto é decisão de preço — decido sozinho?'
    const deps = depsFalso({
      candidatas: [
        linha({
          answeredHash: `escalada:0:${hashDe(mensagem)}`,
          lastProgressAt: new Date(agora.getTime() - 1 * 60 * 60 * 1000), // 1h
        }),
      ],
    })
    const execute = vi.fn(async () => '')

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    expect(execute).not.toHaveBeenCalled()
    expect(deps.avisarDono).not.toHaveBeenCalled()
  })

  it('escalada há MAIS de 24h + execute devolve suposição CONCRETA: entrega ao dev, comenta na issue, marca assumida, registra resposta e NUNCA fecha a sessão', async () => {
    const mensagem = 'Devo usar bcrypt ou argon2 para o hash de senha?'
    const prisma = prismaFalso({
      candidatas: [
        linha({
          sessionName: 'sessions/escalada-suposicao',
          issueNumber: 93,
          answeredHash: `escalada:0:${hashDe(mensagem)}`,
          lastProgressAt: new Date(agora.getTime() - 25 * 60 * 60 * 1000), // 25h
        }),
      ],
    })
    const deps = depsFalso({ prisma, ultimaMensagem: vi.fn(async () => mensagem) })
    const execute = vi.fn(async (_prompt: string) =>
      JSON.stringify({
        suposicao: 'Vou usar argon2id, o mesmo padrão de src/lib/hash.ts, para este endpoint.',
        justificativa: 'É o único helper de hash do repositório e já é usado no login.',
        arquivosCitados: ['src/lib/hash.ts'],
      })
    )

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    // A pergunta original chega inteira ao motor.
    expect(execute.mock.calls[0]?.[0]).toContain(mensagem)
    expect(execute.mock.calls[0]?.[0]).toContain('#93')

    expect(deps.responder).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'sessions/escalada-suposicao',
        texto: expect.stringContaining('src/lib/hash.ts'),
      })
    )
    expect(deps.comentarNaIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 93,
        texto: expect.stringContaining('o dono pode corrigir'),
      })
    )
    expect(deps.marcarAssumida).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 93,
        hash: hashDe(mensagem),
        suposicao: expect.stringContaining('argon2id'),
      })
    )
    expect(prisma._updateCalls).toContainEqual(
      expect.objectContaining({
        where: { sessionName: 'sessions/escalada-suposicao' },
        data: expect.objectContaining({ answeredHash: `respondida:0:${hashDe(mensagem)}` }),
      })
    )
    // NUNCA fecha a sessão: não há sequer um hook de "fechar" nesta função.
    expect(deps.avisarDono).not.toHaveBeenCalled()
  })

  it('escalada há MAIS de 24h + execute devolve suposição SEM NADA concreto: avisa o dono UMA vez, marca escalada:1:, não comenta nem marca assumida', async () => {
    const mensagem = 'Isto é decisão de preço — decido sozinho?'
    const prisma = prismaFalso({
      candidatas: [
        linha({
          sessionName: 'sessions/escalada-vaga',
          issueNumber: 95,
          answeredHash: `escalada:0:${hashDe(mensagem)}`,
          lastProgressAt: new Date(agora.getTime() - 25 * 60 * 60 * 1000),
        }),
      ],
    })
    const deps = depsFalso({ prisma, ultimaMensagem: vi.fn(async () => mensagem) })
    const execute = vi.fn(async () =>
      JSON.stringify({
        suposicao: 'Acho que qualquer abordagem comum serve aqui, sem problema nenhum.',
        justificativa: 'Parece razoável.',
        arquivosCitados: ['algum-arquivo.ts'],
      })
    )

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    expect(deps.responder).not.toHaveBeenCalled()
    expect(deps.comentarNaIssue).not.toHaveBeenCalled()
    expect(deps.marcarAssumida).not.toHaveBeenCalled()
    expect(deps.avisarDono).toHaveBeenCalledWith(
      expect.objectContaining({ wingId: 'acme/api' }),
      expect.stringContaining('#95')
    )
    expect(prisma._updateCalls).toContainEqual(
      expect.objectContaining({
        where: { sessionName: 'sessions/escalada-vaga' },
        data: expect.objectContaining({ answeredHash: `escalada:1:${hashDe(mensagem)}` }),
      })
    )
  })

  it('execute (o motor) lança erro: tratado como "sem suposição concreta" — avisa o dono, nunca derruba o chamador', async () => {
    const mensagem = 'Isto é decisão de preço — decido sozinho?'
    const prisma = prismaFalso({
      candidatas: [
        linha({
          sessionName: 'sessions/escalada-erro-motor',
          issueNumber: 96,
          answeredHash: `escalada:0:${hashDe(mensagem)}`,
          lastProgressAt: new Date(agora.getTime() - 25 * 60 * 60 * 1000),
        }),
      ],
    })
    const deps = depsFalso({ prisma, ultimaMensagem: vi.fn(async () => mensagem) })
    const execute = vi.fn(async () => {
      throw new Error('motor sem cota agora')
    })

    await expect(suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)).resolves.toBeUndefined()

    expect(deps.avisarDono).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('#96'))
  })

  it('aviso JÁ dado antes (escalada:1:): NUNCA avisa o dono duas vezes para a mesma pergunta', async () => {
    const mensagem = 'Isto é decisão de preço — decido sozinho?'
    const prisma = prismaFalso({
      candidatas: [
        linha({
          sessionName: 'sessions/escalada-ja-avisada',
          issueNumber: 97,
          answeredHash: `escalada:1:${hashDe(mensagem)}`,
          lastProgressAt: new Date(agora.getTime() - 30 * 60 * 60 * 1000),
        }),
      ],
    })
    const deps = depsFalso({ prisma, ultimaMensagem: vi.fn(async () => mensagem) })
    const execute = vi.fn(async () =>
      JSON.stringify({
        suposicao: 'Acho que qualquer abordagem comum serve aqui, sem problema nenhum.',
        justificativa: 'Parece razoável.',
        arquivosCitados: ['algum-arquivo.ts'],
      })
    )

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    expect(deps.avisarDono).not.toHaveBeenCalled()
    expect(prisma._updateCalls).toHaveLength(0)
  })

  it('suposição concreta mas a ENTREGA ao dev falha: não comenta, não marca assumida, não registra resposta', async () => {
    const mensagem = 'Devo usar bcrypt ou argon2 para o hash de senha?'
    const prisma = prismaFalso({
      candidatas: [
        linha({
          sessionName: 'sessions/escalada-entrega-falha',
          issueNumber: 94,
          answeredHash: `escalada:0:${hashDe(mensagem)}`,
          lastProgressAt: new Date(agora.getTime() - 25 * 60 * 60 * 1000),
        }),
      ],
    })
    const deps = depsFalso({
      prisma,
      ultimaMensagem: vi.fn(async () => mensagem),
      responder: vi.fn(async () => false),
    })
    const execute = vi.fn(async () =>
      JSON.stringify({
        suposicao: 'Vou usar argon2id, o mesmo padrão de src/lib/hash.ts, para este endpoint.',
        justificativa: 'É o único helper de hash do repositório e já é usado no login.',
        arquivosCitados: ['src/lib/hash.ts'],
      })
    )

    await suporDuvidaPendente({ ...ARGS_BASE, execute }, deps)

    expect(deps.comentarNaIssue).not.toHaveBeenCalled()
    expect(deps.marcarAssumida).not.toHaveBeenCalled()
    expect(prisma._updateCalls).toHaveLength(0)
  })
})
