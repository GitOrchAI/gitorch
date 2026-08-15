import { describe, it, expect } from 'vitest'
import { mesclarPr } from './merge-do-pr.js'

const base = { numeroDoPr: 63, ciState: 'green', vereditoDoQa: 'approve', diffTruncado: false }

describe('mesclarPr', () => {
  it('mescla quando a verificação está verde e o QA aprovou', async () => {
    let chamado = false
    const r = await mesclarPr({
      ...base,
      merge: async () => {
        chamado = true
        return true
      },
    })
    expect(chamado).toBe(true)
    expect(r.mesclado).toBe(true)
  })

  it('NÃO mescla com verificação vermelha', async () => {
    let chamado = false
    const r = await mesclarPr({
      ...base,
      ciState: 'red',
      merge: async () => {
        chamado = true
        return true
      },
    })
    expect(chamado).toBe(false)
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toContain('verificação')
  })

  it('NÃO mescla sem verificação automática nenhuma', async () => {
    const r = await mesclarPr({ ...base, ciState: 'no checks', merge: async () => true })
    expect(r.mesclado).toBe(false)
  })

  it('NÃO mescla com verificação ainda rodando', async () => {
    const r = await mesclarPr({ ...base, ciState: 'pending', merge: async () => true })
    expect(r.mesclado).toBe(false)
  })

  it('NÃO mescla quando o QA reprovou', async () => {
    const r = await mesclarPr({ ...base, vereditoDoQa: 'request_changes', merge: async () => true })
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toContain('QA')
  })

  it('NÃO mescla quando o diff não coube por inteiro', async () => {
    const r = await mesclarPr({ ...base, diffTruncado: true, merge: async () => true })
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toContain('diff')
  })

  it('falha do GitHub no merge não vira exceção, vira motivo', async () => {
    const r = await mesclarPr({
      ...base,
      merge: async () => {
        throw new Error('405 not mergeable')
      },
    })
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toContain('405')
  })
})
