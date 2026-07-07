import { describe, it, expect, vi } from 'vitest'
import { diagnoseWorkspaceIsolated } from './workspace-diagnosis.js'

type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: unknown
) => Promise<{ stdout: string; stderr: string }>

describe('diagnoseWorkspaceIsolated', () => {
  it('faz parse do JSON devolvido pelo filho em sucesso (exit 0)', async () => {
    const diag = {
      fileCount: 3,
      indexedFiles: 3,
      symbolsByType: {},
      largestFiles: [],
      mostCalledFunctions: [],
      untestedModules: [],
      directoryInventory: {},
    }
    const execFileImpl: ExecFileFn = vi.fn(async () => ({
      stdout: JSON.stringify(diag),
      stderr: '',
    }))
    const result = await diagnoseWorkspaceIsolated('/tmp/ws', 90_000, execFileImpl)
    expect(result).toEqual(diag)
  })

  it('devolve undefined quando o filho não indexou nada (stdout "null")', async () => {
    const execFileImpl: ExecFileFn = vi.fn(async () => ({ stdout: 'null', stderr: '' }))
    const result = await diagnoseWorkspaceIsolated('/tmp/ws', 90_000, execFileImpl)
    expect(result).toBeUndefined()
  })

  it('re-tenta excluindo o arquivo envenenado (exit 3) e devolve o resultado da 2ª tentativa', async () => {
    const diag = {
      fileCount: 1,
      indexedFiles: 1,
      symbolsByType: {},
      largestFiles: [],
      mostCalledFunctions: [],
      untestedModules: [],
      directoryInventory: {},
    }
    let call = 0
    const execFileImpl: ExecFileFn = vi.fn(async () => {
      call++
      if (call === 1) {
        const err = new Error('poisoned') as Error & { code: number; stdout: string }
        err.code = 3
        err.stdout = 'POISON:src/bad.ts'
        throw err
      }
      return { stdout: JSON.stringify(diag), stderr: '' }
    })
    const result = await diagnoseWorkspaceIsolated('/tmp/ws', 90_000, execFileImpl)
    expect(result).toEqual(diag)
    expect(execFileImpl).toHaveBeenCalledTimes(2)
    // 2ª chamada exclui o arquivo envenenado da 1ª
    const secondCallArgs = (execFileImpl as ReturnType<typeof vi.fn>).mock.calls[1] as unknown[]
    expect(secondCallArgs[1]).toContain(JSON.stringify(['src/bad.ts']))
  })

  it('desiste em erro não-veneno (crash do filho) sem lançar', async () => {
    const execFileImpl: ExecFileFn = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await diagnoseWorkspaceIsolated('/tmp/ws', 90_000, execFileImpl)
    expect(result).toBeUndefined()
  })
})
