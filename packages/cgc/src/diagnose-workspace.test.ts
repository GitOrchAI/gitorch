import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseWorkspaceStructural } from './diagnose-workspace.js'

describe('diagnoseWorkspaceStructural', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cgc-diag-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'math.ts'),
      'export function somar(a: number, b: number): number {\n  return a + b\n}\n'
    )
    writeFileSync(
      join(dir, 'src', 'main.ts'),
      "import { somar } from './math'\nfunction main() {\n  return somar(1, 2)\n}\n"
    )
    writeFileSync(
      join(dir, 'src', 'main.test.ts'),
      "import { main } from './main'\ntest('main', () => { main() })\n"
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('devolve diagnóstico estruturado (JSON) com fatos reais do repo', async () => {
    const d = await diagnoseWorkspaceStructural(dir)
    expect(d).not.toBeNull()
    expect(d!.indexedFiles).toBe(3)
    expect(d!.largestFiles.length).toBeGreaterThan(0)
    expect(d!.mostCalledFunctions.some((f) => f.name === 'somar')).toBe(true)
    // math.ts não tem teste correspondente -> untested
    expect(d!.untestedModules).toContain('src/math.ts')
    // main.ts TEM teste (main.test.ts) -> não aparece
    expect(d!.untestedModules).not.toContain('src/main.ts')
    expect(d!.directoryInventory['src']).toEqual(
      expect.arrayContaining(['math.ts', 'main.ts', 'main.test.ts'])
    )
  })

  it('devolve null para diretório sem código-fonte (nunca lança)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cgc-diag-empty-'))
    try {
      await expect(diagnoseWorkspaceStructural(empty)).resolves.toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
