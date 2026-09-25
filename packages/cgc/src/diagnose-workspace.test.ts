import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseWorkspaceStructural, diagnoseCrossRepoIntegrity } from './diagnose-workspace.js'

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
    expect(d!.orphanModules).toBeDefined()
    expect(d!.crossPackageDependencies).toBeDefined()
    expect(d!.summary).toBeDefined()
    expect(typeof d!.summary).toBe('string')
    expect(d!.summary.length).toBeGreaterThan(0)
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

import * as exportGraphModule from './export-graph.js'
import { vi } from 'vitest'

describe('diagnoseCrossRepoIntegrity', () => {
  it('returns [ORPHAN_CONTRACT] alert when a frontend file calls an unresolved backend target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-diag-orphan-'))

    // We mock exportGraph to return a predictable graph with an orphaned edge
    const spy = vi.spyOn(exportGraphModule, 'exportGraph').mockResolvedValue({
      nodes: [
        {
          id: 'cgc://repoA/src/frontend.ts',
          label: 'frontend.ts',
          file: 'src/frontend.ts',
          type: 'file',
          health: 'good',
          repositoryId: 'repoA',
        },
      ],
      edges: [
        {
          source: 'cgc://repoA/src/frontend.ts',
          target: 'cgc://repoB/src/backend.ts',
          rel: 'CALLS_CONTRACT',
          repositoryId: 'repoA',
        },
      ],
      truncated: false,
      metrics: { symbolCount: 1, orphanNodes: 0, structuralComplexity: 1 },
    })

    try {
      const alerts = await diagnoseCrossRepoIntegrity(dir)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toBe(
        "[ORPHAN_CONTRACT] File 'cgc://repoA/src/frontend.ts' references unresolved target 'cgc://repoB/src/backend.ts'"
      )
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns no alerts when all targets are resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cgc-diag-resolved-'))

    const spy = vi.spyOn(exportGraphModule, 'exportGraph').mockResolvedValue({
      nodes: [
        {
          id: 'cgc://repoA/src/frontend.ts',
          label: 'frontend.ts',
          file: 'src/frontend.ts',
          type: 'file',
          health: 'good',
          repositoryId: 'repoA',
        },
        {
          id: 'cgc://repoB/src/backend.ts',
          label: 'backend.ts',
          file: 'src/backend.ts',
          type: 'file',
          health: 'good',
          repositoryId: 'repoB',
        },
      ],
      edges: [
        {
          source: 'cgc://repoA/src/frontend.ts',
          target: 'cgc://repoB/src/backend.ts',
          rel: 'CALLS_CONTRACT',
          repositoryId: 'repoA',
        },
      ],
      truncated: false,
      metrics: { symbolCount: 2, orphanNodes: 0, structuralComplexity: 0.5 },
    })

    try {
      const alerts = await diagnoseCrossRepoIntegrity(dir)
      expect(alerts).toHaveLength(0)
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
