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
  it('marca TODA running como failed imediatamente (no boot não há voo legítimo)', async () => {
    let captured: unknown
    const prisma = {
      mission: {
        updateMany: async (a: unknown) => {
          captured = a
          return { count: 3 }
        },
      },
    }
    const n = await failOrphanRunningMissions(prisma)
    expect(n).toBe(3)
    const arg = captured as { where: { status: string }; data: { status: string; error: string } }
    expect(arg.where).toEqual({ status: 'running' })
    expect(arg.data.status).toBe('failed')
    expect(arg.data.error).toContain('restart')
  })

  it('zero running, retorna 0 sem erro', async () => {
    const prisma = { mission: { updateMany: async () => ({ count: 0 }) } }
    expect(await failOrphanRunningMissions(prisma)).toBe(0)
  })
})
