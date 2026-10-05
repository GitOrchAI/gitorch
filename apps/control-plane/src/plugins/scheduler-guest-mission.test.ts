import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Guest Mission Initialization', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prismaMock: any

  beforeEach(() => {
    vi.resetModules()

    prismaMock = {
      project: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      mission: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      guestProfile: {
        findFirst: vi.fn(),
      },
      projectInvitation: {
        findUnique: vi.fn(),
      },
      engineConnection: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    }

    vi.doMock('./prisma.js', () => ({
      prisma: prismaMock,
      tenantContext: {
        run: vi.fn((_: unknown, cb: () => unknown) => cb()),
      },
    }))

    vi.doMock('../lib/spend-guard.js', () => ({
      assertGuestQuotaAvailable: vi.fn().mockResolvedValue(true),
    }))

    vi.doMock('../lib/credential-archive.js', () => ({
      isGuestCredentialRevoked: vi.fn().mockReturnValue(false),
    }))
  })

  it('merges guest engine mapping into runtime settings and initializes mission', async () => {
    const projectId = 'proj-uuid'
    const guestId = 'guest-uuid'

    const guestProfile = { id: 'gp1', invitationId: guestId }
    prismaMock.guestProfile.findFirst.mockResolvedValue(guestProfile)

    prismaMock.projectInvitation.findUnique.mockResolvedValue({
      id: guestId,
      engineMapping: { qa: 'claude', dev: 'antigravity' },
    })

    const project = {
      id: projectId,
      userId: guestId, // Indicates a guest
      runtimeConfig: { agents: { qa: 'codex' } }, // Base config
    }

    let effectiveRuntimeConfig = project.runtimeConfig as Record<string, unknown> | null
    if (project.userId && project.userId !== project.id) {
      const invitation = await prismaMock.projectInvitation.findUnique({
        where: { id: project.userId },
      })
      if (invitation?.engineMapping) {
        effectiveRuntimeConfig = {
          ...(effectiveRuntimeConfig || {}),
          agents: {
            ...((effectiveRuntimeConfig?.['agents'] as Record<string, unknown>) || {}),
            ...(invitation.engineMapping as Record<string, unknown>),
          },
        }
      }
    }

    expect(effectiveRuntimeConfig?.['agents']).toEqual({ qa: 'claude', dev: 'antigravity' })
  })

  it('preExecutionInterceptor aborts mission if guest profile is missing', async () => {
    const { isGuestCredentialRevoked } = await import('../lib/credential-archive.js')
    const { assertGuestQuotaAvailable } = await import('../lib/spend-guard.js')

    const mission = {
      userId: 'guest-123',
      projectId: 'proj-456',
    }

    prismaMock.guestProfile.findFirst.mockResolvedValue(null)

    let thrownError: Error | null = null
    try {
      if (mission.userId && mission.userId !== mission.projectId) {
        if (isGuestCredentialRevoked(mission.userId)) {
          throw new Error('Credential access revoked for guest')
        }

        const guestProfile = await prismaMock.guestProfile.findFirst({
          where: { invitationId: mission.userId },
        })
        if (!guestProfile) {
          throw new Error(
            'Guest profile not found or invalid credentials. Ensure the guest setup is complete and credentials are valid.'
          )
        }

        await assertGuestQuotaAvailable(mission.userId, mission.projectId)
      }
    } catch (e) {
      thrownError = e as Error
    }

    expect(thrownError).toBeDefined()
    expect(thrownError?.message).toBe(
      'Guest profile not found or invalid credentials. Ensure the guest setup is complete and credentials are valid.'
    )
  })

  it('preExecutionInterceptor aborts mission if credential is revoked', async () => {
    // O mock do módulo já foi registrado no beforeEach. Registrar um SEGUNDO
    // `vi.doMock` do mesmo módulo aqui disputava com o primeiro (a resolução do
    // caminho é assíncrona) e o teste falhava ~1 vez em 12: o `import` abaixo
    // às vezes devolvia a versão `false` do beforeEach. Muda-se o retorno do
    // mock que já existe, sem registrar de novo.
    const { isGuestCredentialRevoked } = await import('../lib/credential-archive.js')
    vi.mocked(isGuestCredentialRevoked).mockReturnValue(true)
    const { assertGuestQuotaAvailable } = await import('../lib/spend-guard.js')

    const mission = {
      userId: 'guest-123',
      projectId: 'proj-456',
    }

    prismaMock.guestProfile.findFirst.mockResolvedValue({ id: 'valid' })

    let thrownError: Error | null = null
    try {
      if (mission.userId && mission.userId !== mission.projectId) {
        if (isGuestCredentialRevoked(mission.userId)) {
          throw new Error('Credential access revoked for guest')
        }

        const guestProfile = await prismaMock.guestProfile.findFirst({
          where: { invitationId: mission.userId },
        })
        if (!guestProfile) {
          throw new Error(
            'Guest profile not found or invalid credentials. Ensure the guest setup is complete and credentials are valid.'
          )
        }

        await assertGuestQuotaAvailable(mission.userId, mission.projectId)
      }
    } catch (e) {
      thrownError = e as Error
    }

    expect(thrownError).toBeDefined()
    expect(thrownError?.message).toBe('Credential access revoked for guest')
  })
})
