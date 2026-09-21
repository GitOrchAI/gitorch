import { describe, it, expect } from 'vitest'
import { computeUntestedModules } from './untested-modules.js'

describe('computeUntestedModules', () => {
  it('acha módulos-fonte sem arquivo de teste correspondente (por caminho relativo)', () => {
    const files = [
      { relPath: 'src/lib/foo.ts' },
      { relPath: 'src/lib/foo.test.ts' }, // testa foo -> foo coberto
      { relPath: 'src/lib/bar.ts' }, // sem teste em lugar nenhum -> untested
      { relPath: 'src/core/baz.ts' },
      { relPath: 'src/core/__tests__/baz.test.ts' }, // testa baz em pasta separada -> coberto
      { relPath: 'src/lib/baz.spec.ts' }, // .spec também conta
      { relPath: 'src/lib/index.ts' }, // outro arquivo, não deve casar com o index de core
      { relPath: 'src/core/index.ts' },
      { relPath: 'src/core/__tests__/index.test.ts' }, // testa apenas core/index.ts
    ]
    const result = computeUntestedModules(files)
    expect(result).toEqual(['src/lib/bar.ts', 'src/lib/index.ts'])
  })

  it('não lista os próprios arquivos de teste como não-testados', () => {
    const files = [{ relPath: 'src/only.test.ts' }]
    expect(computeUntestedModules(files)).toEqual([])
  })

  it('lista vazia sem arquivos', () => {
    expect(computeUntestedModules([])).toEqual([])
  })
})
