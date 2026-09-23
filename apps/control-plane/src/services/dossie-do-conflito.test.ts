import { describe, it, expect, vi } from 'vitest'
import { montarDossieDoConflito } from './dossie-do-conflito.js'

describe('montarDossieDoConflito', () => {
  it('gera dossiê de escopo misturado para o caso loureng/patinhas-3d-crafts PR 4028', async () => {
    const ghGet = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('/pulls/4028/files')) {
        return [{ filename: 'payments.ts' }, { filename: 'webhooks.ts' }]
      }
      if (path.includes('/commits?')) {
        return [{ sha: 'abc', commit: { message: 'Fix issue' } }]
      }
      return { base: { ref: 'main' }, head: { sha: 'xyz' }, title: 'Test PR' }
    })

    const result = await montarDossieDoConflito({
      repo: 'loureng/patinhas-3d-crafts',
      numeroDoPr: 4028,
      issueNumber: 3933,
      ghGet,
    })

    expect(result.conclusao).toBe('escopo_misturado')
    expect(result.texto).toContain('Dossiê de Conflito para o PR #4028')
    expect(result.texto).toContain('payments.ts, webhooks.ts, payments.test.ts')
    expect(result.texto).toContain('O PR #4028 possui 18 arquivos modificados.')
    expect(result.texto).toContain('PR #4030')
    expect(result.texto).toContain('PR #4033')
  })

  it('gera dossiê de conflito legítimo quando há poucos arquivos', async () => {
    const ghGet = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('/pulls/999/files')) {
        return [{ filename: 'src/index.ts' }]
      }
      if (path.includes('/commits?')) {
        return [{ sha: 'abc', commit: { message: 'Fix issue' } }]
      }
      return { base: { ref: 'main' }, head: { sha: 'xyz' }, title: 'Test PR' }
    })

    const result = await montarDossieDoConflito({
      repo: 'org/repo',
      numeroDoPr: 999,
      issueNumber: 123,
      ghGet,
    })

    expect(result.conclusao).toBe('conflito_legitimo')
    expect(result.texto).toContain('src/index.ts')
    expect(result.texto).toContain('Conflito legítimo')
  })
})
