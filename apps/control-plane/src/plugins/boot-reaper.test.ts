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
    const removed = await reapOrphanContainers(run, 'podman')
    expect(removed).toEqual(['gitorch-mission-a', 'gitorch-mission-b'])
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
    expect(await reapOrphanContainers(run, 'podman')).toEqual([])
    expect(calls.length).toBe(1)
  })

  it('rm de um container falhando não impede a remoção dos demais da lista', async () => {
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
      if (req.args[2] === 'gitorch-mission-a') throw new Error('no such container')
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
    }
    const removed = await reapOrphanContainers(run, 'podman')
    expect(removed).toEqual(['gitorch-mission-a', 'gitorch-mission-b'])
    // rm foi tentado para os dois, mesmo o primeiro tendo falhado.
    expect(calls).toEqual([
      ['podman', 'ps', '-a', '--filter', 'name=gitorch-mission-', '--format', '{{.Names}}'],
      ['podman', 'rm', '-f', 'gitorch-mission-a'],
      ['podman', 'rm', '-f', 'gitorch-mission-b'],
    ])
  })

  it('falha do `ps` (ex.: binário ausente) propaga — o chamador decide logar e seguir', async () => {
    const run: RuntimeCommandRunner = async () => {
      throw new Error('spawn podman ENOENT')
    }
    await expect(reapOrphanContainers(run, 'podman')).rejects.toThrow('spawn podman ENOENT')
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
