import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconferirAcessoDoRelogio } from './scheduler.js'

/**
 * O ponto de LIGAÇÃO entre o relógio e a reconferência de acesso.
 *
 * A decisão em si é pura e está testada caso a caso em
 * services/reconferencia-de-acesso.test.ts. O que este arquivo prova é o que
 * só o wiring pode errar: de onde vêm os projetos, com qual credencial a
 * pergunta é feita, e o que é gravado no banco quando a resposta é "não
 * escreve mais aqui".
 */

const AGORA = new Date('2026-03-10T12:00:00Z')

/** O que o Prisma recebe para gravar o estado de acesso de um projeto. */
interface ArgumentoDoUpdate {
  where: { id: string }
  data: Record<string, unknown>
}

const PODE_ESCREVER = { admin: true, maintain: true, push: true, triage: true, pull: true }

function fakeApp(args: {
  projetos: Array<Record<string, unknown>>
  update: ReturnType<typeof vi.fn>
  getRawGithubToken?: ReturnType<typeof vi.fn>
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    prisma: {
      project: {
        findMany: vi.fn(async () => args.projetos),
        findUnique: vi.fn(async () => args.projetos[0]),
        update: args.update,
      },
    },
    engineConnections: {
      getRawGithubToken: args.getRawGithubToken ?? vi.fn(async () => 'gho_do_dono'),
    },
  } as never
}

describe('reconferirAcessoDoRelogio', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('dono removido do repositório: o projeto é SUSPENSO no banco, com data e motivo', async () => {
    const update = vi.fn(async (_args: ArgumentoDoUpdate) => undefined)
    // O GitHub esconde repositório inacessível atrás de 404 — é o "não" dele.
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    ) as unknown as typeof fetch

    const resumo = await reconferirAcessoDoRelogio(
      fakeApp({
        update,
        projetos: [
          {
            id: 'proj_1',
            wingId: 'acme/api',
            userId: 'user_1',
            accessCheckedAt: null,
            accessSuspendedAt: null,
            accessSuspendedReason: null,
            accessCheckFailures: 0,
          },
        ],
      }),
      AGORA
    )

    expect(resumo.suspensos).toBe(1)
    const argumento = update.mock.calls[0]?.[0]
    expect(argumento?.where.id).toBe('proj_1')
    expect(argumento?.data['accessSuspendedAt']).toEqual(AGORA)
    expect(argumento?.data['accessCheckedAt']).toEqual(AGORA)
    expect(String(argumento?.data['accessSuspendedReason'])).toContain('acme/api')
  })

  it('a pergunta vai para o repositório do projeto, com a credencial do DONO', async () => {
    const update = vi.fn(async (_args: ArgumentoDoUpdate) => undefined)
    const getRawGithubToken = vi.fn(async () => 'gho_do_dono')
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(JSON.stringify({ full_name: 'acme/api', permissions: PODE_ESCREVER }), {
          status: 200,
        })
    )
    global.fetch = fetchImpl as unknown as typeof fetch

    await reconferirAcessoDoRelogio(
      fakeApp({
        update,
        getRawGithubToken,
        projetos: [
          {
            id: 'proj_1',
            wingId: 'acme/api',
            userId: 'user_1',
            accessCheckedAt: null,
            accessSuspendedAt: null,
            accessSuspendedReason: null,
            accessCheckFailures: 0,
          },
        ],
      }),
      AGORA
    )

    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.github.com/repos/acme/api')
  })

  it('GitHub fora do ar não suspende ninguém — só registra a falha', async () => {
    const update = vi.fn(async (_args: ArgumentoDoUpdate) => undefined)
    global.fetch = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch

    const resumo = await reconferirAcessoDoRelogio(
      fakeApp({
        update,
        projetos: [
          {
            id: 'proj_1',
            wingId: 'acme/api',
            userId: 'user_1',
            accessCheckedAt: null,
            accessSuspendedAt: null,
            accessSuspendedReason: null,
            accessCheckFailures: 0,
          },
        ],
      }),
      AGORA
    )

    expect(resumo.suspensos).toBe(0)
    const dados = update.mock.calls[0]?.[0]?.data ?? {}
    expect(dados['accessSuspendedAt']).toBeNull()
    expect(dados['accessCheckFailures']).toBe(1)
  })

  it('acesso de volta: a suspensão é apagada sozinha', async () => {
    const update = vi.fn(async (_args: ArgumentoDoUpdate) => undefined)
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ full_name: 'acme/api', permissions: PODE_ESCREVER }), {
          status: 200,
        })
    ) as unknown as typeof fetch

    const resumo = await reconferirAcessoDoRelogio(
      fakeApp({
        update,
        projetos: [
          {
            id: 'proj_1',
            wingId: 'acme/api',
            userId: 'user_1',
            accessCheckedAt: new Date('2026-03-09T00:00:00Z'),
            accessSuspendedAt: new Date('2026-03-09T00:00:00Z'),
            accessSuspendedReason: 'sem escrita',
            accessCheckFailures: 0,
          },
        ],
      }),
      AGORA
    )

    expect(resumo.liberados).toBe(1)
    const dados = update.mock.calls[0]?.[0]?.data ?? {}
    expect(dados['accessSuspendedAt']).toBeNull()
    expect(dados['accessSuspendedReason']).toBeNull()
  })

  it('só projetos ATIVOS entram na conferência', async () => {
    const update = vi.fn(async (_args: ArgumentoDoUpdate) => undefined)
    const app = fakeApp({ update, projetos: [] })
    global.fetch = vi.fn(async () => {
      throw new Error('não deveria perguntar nada sem projeto')
    }) as unknown as typeof fetch

    await reconferirAcessoDoRelogio(app, AGORA)

    const findMany = (
      app as unknown as { prisma: { project: { findMany: ReturnType<typeof vi.fn> } } }
    ).prisma.project.findMany
    const where = (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where
    expect(where['isActive']).toBe(true)
  })
})
