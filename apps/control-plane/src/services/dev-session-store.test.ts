import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  abrirSessao,
  sessoesVivas,
  registrarEstado,
  registrarResposta,
  registrarPr,
  fecharSessao,
  registrarPendencia,
  registrarFracassoDeMerge,
  registrarMescla,
  registrarEstadoDaPublicacao,
} from './dev-session-store.js'

const agora = new Date('2026-01-01T00:00:00.000Z')

function prismaFalso(overrides: Record<string, unknown> = {}) {
  return {
    devSession: {
      // Os argumentos sao declarados para que `mock.calls[0]?.[0]` tenha tipo;
      // sem isso o TypeScript infere uma tupla vazia e a asserção nao compila.
      upsert: vi.fn(async (_args: unknown) => undefined),
      update: vi.fn(async (_args: unknown) => undefined),
      updateMany: vi.fn(async (_args: unknown) => undefined),
      findMany: vi.fn(async (_args: unknown) => []),
      findFirst: vi.fn(async (_args: unknown) => null),
      ...overrides,
    },
  }
}

describe('abrirSessao', () => {
  it('a mesma sessão duas vezes não cria duas linhas: conta a tentativa e reabre', async () => {
    const prisma = prismaFalso()

    await abrirSessao({
      prisma,
      projectId: 'p1',
      issueNumber: 24,
      sessionName: 'sessions/1',
      agora,
    })

    expect(prisma.devSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionName: 'sessions/1' },
        update: expect.objectContaining({
          attempts: { increment: 1 },
          closedAt: null,
          closedReason: null,
        }),
      })
    )
  })

  it('a linha nasce viva e com marca de progresso, senão a vigia a trataria como parada de saída', async () => {
    const prisma = prismaFalso()

    await abrirSessao({
      prisma,
      projectId: 'p1',
      issueNumber: 24,
      sessionName: 'sessions/1',
      agora,
    })

    const chamada = prisma.devSession.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>
    }
    expect(chamada.create).toEqual(
      expect.objectContaining({
        projectId: 'p1',
        issueNumber: 24,
        sessionName: 'sessions/1',
        state: 'QUEUED',
        lastProgressAt: agora,
      })
    )
  })

  it('caminho feliz devolve { ok: true }', async () => {
    const prisma = prismaFalso()

    const resultado = await abrirSessao({
      prisma,
      projectId: 'p1',
      issueNumber: 24,
      sessionName: 'sessions/1',
      agora,
    })

    expect(resultado).toEqual({ ok: true })
  })

  it('violação do índice único parcial (P2002) vira resultado tipado, não exceção crua — duas delegações da mesma issue geram sessionName diferentes e caem as duas no ramo create do upsert', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: ['project_id', 'issue_number'] },
    })
    const prisma = prismaFalso({ upsert: vi.fn(async (_args: unknown) => Promise.reject(p2002)) })

    const resultado = await abrirSessao({
      prisma,
      projectId: 'p1',
      issueNumber: 24,
      sessionName: 'sessions/2',
      agora,
    })

    expect(resultado).toEqual({ ok: false, motivo: 'ja-existe-sessao-viva' })
  })

  it('qualquer OUTRO erro (fora P2002) continua sendo lançado — não engole erro desconhecido', async () => {
    const outroErro = new Error('conexão com o banco caiu')
    const prisma = prismaFalso({
      upsert: vi.fn(async (_args: unknown) => Promise.reject(outroErro)),
    })

    await expect(
      abrirSessao({
        prisma,
        projectId: 'p1',
        issueNumber: 24,
        sessionName: 'sessions/1',
        agora,
      })
    ).rejects.toThrow('conexão com o banco caiu')
  })
})

describe('sessoesVivas', () => {
  it('só traz linha aberta — é o que mantém a vigia escopada em vez de global', async () => {
    const prisma = prismaFalso()

    await sessoesVivas({ prisma, projectId: 'p1' })

    expect(prisma.devSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ closedAt: null }) })
    )
  })

  it('projectId é obrigatório: o filtro por projeto SEMPRE entra na consulta, nunca varre entre projetos', async () => {
    const prisma = prismaFalso()

    await sessoesVivas({ prisma, projectId: 'p1' })

    expect(prisma.devSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { closedAt: null, projectId: 'p1' } })
    )
  })
})

describe('registrarEstado', () => {
  it('sem avanço, a marca de progresso NÃO é tocada: é ela que denuncia sessão parada', async () => {
    const prisma = prismaFalso()

    await registrarEstado({ prisma, sessionName: 'sessions/1', estado: 'IN_PROGRESS', agora })

    const chamada = prisma.devSession.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(chamada.data['state']).toBe('IN_PROGRESS')
    expect(chamada.data).not.toHaveProperty('lastProgressAt')
  })

  it('com avanço, a marca de progresso anda', async () => {
    const prisma = prismaFalso()

    await registrarEstado({
      prisma,
      sessionName: 'sessions/1',
      estado: 'IN_PROGRESS',
      agora,
      progrediu: true,
    })

    const chamada = prisma.devSession.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(chamada.data['lastProgressAt']).toBe(agora)
  })
})

describe('registrarResposta', () => {
  it('guarda o hash da pergunta respondida e conta a insistência', async () => {
    const prisma = prismaFalso()

    await registrarResposta({ prisma, sessionName: 'sessions/1', hashDaPergunta: 'h1', agora })

    expect(prisma.devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ answeredHash: 'h1', nudges: { increment: 1 } }),
      })
    )
  })
})

describe('registrarPr', () => {
  it('grava o NÚMERO do PR e nada que se pareça com uma URL de fora', async () => {
    const prisma = prismaFalso()

    await registrarPr({ prisma, sessionName: 'sessions/1', numeroDoPr: 63, agora })

    const chamada = prisma.devSession.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(chamada.data['pullRequestNumber']).toBe(63)
    expect(JSON.stringify(chamada.data)).not.toContain('http')
  })
})

describe('fecharSessao', () => {
  it('registra o motivo e a hora — é assim que a linha sai da vigia', async () => {
    const prisma = prismaFalso()

    await fecharSessao({ prisma, sessionName: 'sessions/1', motivo: 'merged', agora })

    expect(prisma.devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionName: 'sessions/1' },
        data: expect.objectContaining({ closedAt: agora, closedReason: 'merged' }),
      })
    )
  })
})

// Achado 3 da revisão da Tarefa 7: o `where` de `registrarPendencia` inclui
// `pendingSince: null` — a marca é do PRIMEIRO avistamento — mas até aqui
// nenhum teste exercitava essa cláusula. Se um edit futuro derrubasse o
// filtro, a marca seria regravada a cada passagem, o teto de espera nunca
// amadureceria, e a espera ficaria silenciosa e infinita — com toda a suíte
// (inclusive `qa-rails-mission.test.ts`, que só mocka `registrarPendencia`
// e nunca prova o `where`) permanecendo verde.
describe('registrarPendencia', () => {
  it('o where inclui pendingSince: null — sem isto o teste em memória abaixo não provaria nada', async () => {
    const prisma = prismaFalso()

    await registrarPendencia({ prisma, sessionName: 'sessions/1', agora })

    expect(prisma.devSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionName: 'sessions/1', pendingSince: null },
        data: { pendingSince: agora },
      })
    )
  })

  it('uma sessão JÁ marcada não tem a marca sobrescrita — a marca é do primeiro avistamento', async () => {
    // Simula o WHERE do Prisma de verdade: `updateMany` só aplica `data`
    // quando TODAS as condições do `where` batem contra a linha em memória.
    // É essa fidelidade que prova (e não só documenta) que a proteção vem do
    // FILTRO em si, e não de algum outro comportamento do teste.
    const linha: { pendingSince: Date | null } = { pendingSince: null }
    const prisma = prismaFalso({
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: { pendingSince: Date } }) => {
          const bate = Object.entries(args.where).every(([campo, valor]) =>
            campo === 'sessionName' ? true : linha[campo as keyof typeof linha] === valor
          )
          if (bate) linha.pendingSince = args.data.pendingSince
          return { count: bate ? 1 : 0 }
        }
      ),
    })

    const primeiroAvistamento = new Date('2026-01-01T00:00:00.000Z')
    await registrarPendencia({ prisma, sessionName: 'sessions/1', agora: primeiroAvistamento })
    expect(linha.pendingSince).toEqual(primeiroAvistamento)

    // Segunda passagem, bem depois — a pendência continua, a marca NÃO pode
    // mudar: é dela que o teto de 90min (TETO_DE_ESPERA_MS) conta o tempo.
    const passagemSeguinte = new Date('2026-01-01T00:45:00.000Z')
    await registrarPendencia({ prisma, sessionName: 'sessions/1', agora: passagemSeguinte })

    expect(linha.pendingSince).toEqual(primeiroAvistamento)
  })
})

describe('registrarFracassoDeMerge', () => {
  it('grava o contador e a hora do fracasso — o número já vem pronto de quem chama', async () => {
    const prisma = prismaFalso()

    await registrarFracassoDeMerge({ prisma, sessionName: 'sessions/1', contador: 2, agora })

    expect(prisma.devSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionName: 'sessions/1' },
        data: { mergeFailures: 2, mergeLastFailedAt: agora },
      })
    )
  })

  it('não toca em answeredHash — o teto de mescla tem estado próprio, não disputa campo com o aviso de demora', async () => {
    const prisma = prismaFalso()

    await registrarFracassoDeMerge({ prisma, sessionName: 'sessions/1', contador: 1, agora })

    const chamada = prisma.devSession.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(chamada.data).not.toHaveProperty('answeredHash')
  })
})

describe('registrarMescla', () => {
  it('grava o commit mesclado e NÃO fecha a linha (Tarefa 17: a sessão só encerra com veredito de publicação)', async () => {
    const prisma = prismaFalso()

    await registrarMescla({ prisma, sessionName: 'sessions/1', mergeCommitSha: 'deadbeef', agora })

    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/1' },
      data: { mergeCommitSha: 'deadbeef', stateCheckedAt: agora },
    })
    const chamada = prisma.devSession.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(chamada.data).not.toHaveProperty('closedAt')
    expect(chamada.data).not.toHaveProperty('closedReason')
  })
})

describe('registrarEstadoDaPublicacao', () => {
  it('grava o veredito e quando foi checado — é o que dá a cadência da vigília', async () => {
    const prisma = prismaFalso()

    await registrarEstadoDaPublicacao({
      prisma,
      sessionName: 'sessions/1',
      estado: 'publicando',
      agora,
    })

    expect(prisma.devSession.update).toHaveBeenCalledWith({
      where: { sessionName: 'sessions/1' },
      data: { deployState: 'publicando', deployCheckedAt: agora },
    })
  })
})
