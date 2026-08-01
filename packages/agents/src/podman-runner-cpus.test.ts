import { describe, it, expect } from 'vitest'
import { createPodmanCommandRunner } from './podman-runner.js'
import type {
  RuntimeCommandRequest,
  RuntimeCommandResult,
  RuntimeCommandRunner,
} from './runtime-adapter.js'

const capture = (): { runner: RuntimeCommandRunner; calls: string[][] } => {
  const calls: string[][] = []
  const runner: RuntimeCommandRunner = async (req): Promise<RuntimeCommandResult> => {
    calls.push([req.binary, ...req.args])
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
  }
  return { runner, calls }
}

const request: RuntimeCommandRequest = { binary: 'agy', args: [], env: {} }

describe('teto de CPU por missão (P2-4)', () => {
  it('passa --cpus quando configurado', async () => {
    const { runner, calls } = capture()
    await createPodmanCommandRunner({ image: 'img', hostRunner: runner, cpus: '1.5' })(request)
    const args = calls[0]!
    const i = args.indexOf('--cpus')
    expect(i).toBeGreaterThan(0)
    expect(args[i + 1]).toBe('1.5')
  })
  it('sem a opção, não emite a flag (compat com hosts atuais)', async () => {
    const { runner, calls } = capture()
    await createPodmanCommandRunner({ image: 'img', hostRunner: runner })(request)
    expect(calls[0]!).not.toContain('--cpus')
  })
})
