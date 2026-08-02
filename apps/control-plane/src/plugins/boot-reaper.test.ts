import { describe, it, expect } from 'vitest'
import { reapOrphanContainers, failOrphanRunningMissions } from './boot-reaper.js'
import type { RuntimeCommandRunner } from '@gitorch/agents'

describe('reapOrphanContainers', () => {
  it('lista gitorch-mission-* e remove cada um com rm -f', async () => {
    const calls: string[][] = []
    const run: RuntimeCommandRunner = async (req) => {
      calls.push([req.binary, ...req.args])
      if (req.args[0] === 'ps') {
        return {
          exitCode: 0,
          stdout: 'gitorch-mission-a\ngitorch-mission-b\n',
          stderr: '',
          durationMs: 0,
        }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
    }
    const result = await reapOrphanContainers(run, 'podman')
    expect(result).toEqual({ removed: ['gitorch-mission-a', 'gitorch-mission-b'], failed: [] })
    expect(calls[0]).toEqual([
      'podman',
      'ps',
      '-a',
      '--filter',
      'name=gitorch-mission-',
      '--format',
      '{{.Names}}',
    ])
    expect(calls[1]).toEqual(['podman', 'rm', '-f', 'gitorch-mission-a'])
    expect(calls[2]).toEqual(['podman', 'rm', '-f', 'gitorch-mission-b'])
  })

  it('sem órfãos, não chama rm', async () => {
    const calls: string[][] = []
    const run: RuntimeCommandRunner = async (req) => {
      calls.push([req.binary, ...req.args])
      return { exitCode: 0, stdout: '\n', stderr: '', durationMs: 0 }
    }
    expect(await reapOrphanContainers(run, 'podman')).toEqual({ removed: [], failed: [] })
    expect(calls.length).toBe(1)
  })

  it('rm falhando via exitCode não-zero (contrato real do runner — ver runtime-adapter.ts) não impede a remoção dos demais e vai para `failed`, nunca `removed`', async () => {
    const calls: string[][] = []
    const run: RuntimeCommandRunner = async (req) => {
      calls.push([req.binary, ...req.args])
      if (req.args[0] === 'ps') {
        return {
          exitCode: 0,
          stdout: 'gitorch-mission-a\ngitorch-mission-b\n',
          stderr: '',
          durationMs: 0,
        }
      }
      // Contrato real: ENOENT/EACCES/timeout RESOLVEM com exitCode != 0,
      // nunca rejeitam (ver realRuntimeCommandRunner).
      if (req.args[2] === 'gitorch-mission-a') {
        return { exitCode: 1, stdout: '', stderr: 'no such container', durationMs: 0 }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
    }
    const result = await reapOrphanContainers(run, 'podman')
    expect(result).toEqual({
      removed: ['gitorch-mission-b'],
      failed: [{ name: 'gitorch-mission-a', stderr: 'no such container' }],
    })
    // rm foi tentado para os dois, mesmo o primeiro tendo falhado.
    expect(calls).toEqual([
      ['podman', 'ps', '-a', '--filter', 'name=gitorch-mission-', '--format', '{{.Names}}'],
      ['podman', 'rm', '-f', 'gitorch-mission-a'],
      ['podman', 'rm', '-f', 'gitorch-mission-b'],
    ])
  })

  it('rm rejeitando (caminho genuinamente excepcional, não o contrato real do runner) também vai para `failed` sem abortar os demais', async () => {
    const run: RuntimeCommandRunner = async (req) => {
      if (req.args[0] === 'ps') {
        return {
          exitCode: 0,
          stdout: 'gitorch-mission-a\ngitorch-mission-b\n',
          stderr: '',
          durationMs: 0,
        }
      }
      if (req.args[2] === 'gitorch-mission-a') throw new Error('erro inesperado no runner')
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
    }
    const result = await reapOrphanContainers(run, 'podman')
    expect(result).toEqual({
      removed: ['gitorch-mission-b'],
      failed: [{ name: 'gitorch-mission-a', stderr: 'erro inesperado no runner' }],
    })
  })

  it('falha do `ps` via rejeição (ex.: erro inesperado no runner) propaga — o chamador decide logar e seguir', async () => {
    const run: RuntimeCommandRunner = async () => {
      throw new Error('spawn podman ENOENT')
    }
    await expect(reapOrphanContainers(run, 'podman')).rejects.toThrow('spawn podman ENOENT')
  })

  it('falha do `ps` via exitCode não-zero (contrato real: podman ausente/permissão negada resolvem, não rejeitam) propaga — sem isto, stdout vazio é indistinguível de "zero órfãos"', async () => {
    const run: RuntimeCommandRunner = async () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'podman: command not found',
      durationMs: 0,
    })
    await expect(reapOrphanContainers(run, 'podman')).rejects.toThrow('exitCode=127')
  })
})

describe('failOrphanRunningMissions', () => {
  it('marca running ANTERIOR ao boot como failed imediatamente (no boot não há voo legítimo mais velho que ele)', async () => {
    let captured: unknown
    const prisma = {
      mission: {
        updateMany: async (a: unknown) => {
          captured = a
          return { count: 3 }
        },
      },
    }
    const bootAt = new Date('2026-01-01T00:00:00.000Z')
    const n = await failOrphanRunningMissions(prisma, bootAt)
    expect(n).toBe(3)
    const arg = captured as {
      where: { status: string; startedAt: { lt: Date } }
      data: { status: string; error: string }
    }
    expect(arg.where).toEqual({ status: 'running', startedAt: { lt: bootAt } })
    expect(arg.data.status).toBe('failed')
    expect(arg.data.error).toContain('restart')
  })

  it('zero running, retorna 0 sem erro', async () => {
    const prisma = { mission: { updateMany: async () => ({ count: 0 }) } }
    expect(await failOrphanRunningMissions(prisma, new Date())).toBe(0)
  })

  // Achado M1: uma missão disparada de verdade (ex.: via rota admin/QA) nos
  // segundos entre o boot e este ceifador terminar (caminho podman: `ps` + N
  // × `rm -f`) nasce DEPOIS de `bootAt` — nunca pode ter sido deixada pelo
  // processo anterior, e o ceifador não pode marcá-la failed. Simula o filtro
  // real do Postgres (`startedAt < bootAt`) contra duas missões fixas pra
  // provar a SEMÂNTICA do filtro, não só que o argumento foi passado adiante.
  it('não falha missão com startedAt DEPOIS do boot (dispatch real logo após listen())', async () => {
    const bootAt = new Date('2026-01-01T00:00:00.000Z')
    const missions = [
      {
        id: 'orfa-antes-do-boot',
        status: 'running',
        startedAt: new Date('2025-12-31T23:00:00.000Z'),
      },
      {
        id: 'dispatch-real-apos-boot',
        status: 'running',
        startedAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ]
    const prisma = {
      mission: {
        updateMany: async (args: unknown) => {
          const { where } = args as { where: { status: string; startedAt: { lt: Date } } }
          const affected = missions.filter(
            (m) => m.status === where.status && m.startedAt < where.startedAt.lt
          )
          return { count: affected.length }
        },
      },
    }
    const n = await failOrphanRunningMissions(prisma, bootAt)
    expect(n).toBe(1)
  })
})
