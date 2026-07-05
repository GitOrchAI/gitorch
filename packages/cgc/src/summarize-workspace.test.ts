import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeWorkspace } from './summarize-workspace'

describe('summarizeWorkspace', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cgc-sum-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'math.ts'),
      'export function somar(a: number, b: number): number {\n  return a + b\n}\n'
    )
    writeFileSync(
      join(dir, 'src', 'main.ts'),
      "import { somar } from './math'\nfunction main() {\n  return somar(1, 2)\n}\n"
    )
    // Ruído que NÃO deve ser indexado (node_modules).
    writeFileSync(join(dir, 'node_modules', 'junk', 'x.ts'), 'export const x = 1\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('produz um resumo do grafo a partir do código real, ignorando node_modules', async () => {
    const summary = await summarizeWorkspace(dir)
    expect(summary).toContain('Code graph')
    // Deve ter indexado os 2 arquivos de src, não o de node_modules.
    expect(summary).toContain('Indexed 2 source file(s)')
    // 'somar' é chamada por main -> aparece em most-called.
    expect(summary).toContain('somar')
  })

  it('devolve string vazia (nunca lança) para diretório sem código-fonte', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cgc-empty-'))
    try {
      await expect(summarizeWorkspace(empty)).resolves.toBe('')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('gasta o orçamento de parse com código-fonte antes de testes', async () => {
    const budget = mkdtempSync(join(tmpdir(), 'cgc-budget-'))
    try {
      mkdirSync(join(budget, 'src'), { recursive: true })
      mkdirSync(join(budget, '__tests__'), { recursive: true })
      writeFileSync(join(budget, 'src', 'core.ts'), 'export function core(): number { return 1 }\n')
      writeFileSync(
        join(budget, '__tests__', 'core.test.ts'),
        'export function emTeste(): number { return 2 }\n'
      )
      // Orçamento de 1: o arquivo de src ganha do arquivo de teste.
      const summary = await summarizeWorkspace(budget, { maxFiles: 1 })
      expect(summary).toContain('src/core.ts')
      expect(summary).not.toContain('core.test.ts')
    } finally {
      rmSync(budget, { recursive: true, force: true })
    }
  })

  it('excludeFiles pula o arquivo indicado', async () => {
    const summary = await summarizeWorkspace(dir, { excludeFiles: ['src/main.ts'] })
    expect(summary).toContain('Indexed 1 source file(s)')
  })
})
