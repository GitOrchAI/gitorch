import { describe, it, expect, vi } from 'vitest'
import { exportGraphIsolated } from './graph-export.js'

type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: unknown
) => Promise<{ stdout: string; stderr: string }>

describe('exportGraphIsolated', () => {
  it('faz parse do JSON devolvido pelo filho em sucesso (exit 0)', async () => {
    const graph = {
      nodes: [{ id: 'a', label: 'a', file: 'src/a.ts', type: 'function', health: 'good' }],
      edges: [],
      truncated: false,
    }
    const execFileImpl: ExecFileFn = vi.fn(async () => ({
      stdout: JSON.stringify(graph),
      stderr: '',
    }))
    const result = await exportGraphIsolated('/tmp/ws', 1500, 90_000, execFileImpl)
    expect(result).toEqual(graph)
  })

  it('passa maxNodes pro filho como argv[4]', async () => {
    const execFileImpl: ExecFileFn = vi.fn(async () => ({ stdout: 'null', stderr: '' }))
    await exportGraphIsolated('/tmp/ws', 42, 90_000, execFileImpl)
    const args = (execFileImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as unknown[]
    expect(args).toContain('42')
  })

  it('devolve undefined quando o filho não indexou nada (stdout "null")', async () => {
    const execFileImpl: ExecFileFn = vi.fn(async () => ({ stdout: 'null', stderr: '' }))
    const result = await exportGraphIsolated('/tmp/ws', 1500, 90_000, execFileImpl)
    expect(result).toBeUndefined()
  })

  it('re-tenta excluindo o arquivo envenenado (exit 3) e devolve o resultado da 2ª tentativa', async () => {
    const graph = { nodes: [], edges: [], truncated: false }
    let call = 0
    const execFileImpl: ExecFileFn = vi.fn(async () => {
      call++
      if (call === 1) {
        const err = new Error('poisoned') as Error & { code: number; stdout: string }
        err.code = 3
        err.stdout = 'POISON:src/bad.ts'
        throw err
      }
      return { stdout: JSON.stringify(graph), stderr: '' }
    })
    const result = await exportGraphIsolated('/tmp/ws', 1500, 90_000, execFileImpl)
    expect(result).toEqual(graph)
    expect(execFileImpl).toHaveBeenCalledTimes(2)
    const secondCallArgs = (execFileImpl as ReturnType<typeof vi.fn>).mock.calls[1] as unknown[]
    expect(secondCallArgs[1]).toContain(JSON.stringify(['src/bad.ts']))
  })

  it('desiste em erro não-veneno (crash do filho) sem lançar', async () => {
    const execFileImpl: ExecFileFn = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await exportGraphIsolated('/tmp/ws', 1500, 90_000, execFileImpl)
    expect(result).toBeUndefined()
  })
})
