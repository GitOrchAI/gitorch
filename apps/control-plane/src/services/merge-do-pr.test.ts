import { describe, it, expect } from 'vitest'
import { mesclarPr } from './merge-do-pr.js'

const base = {
  numeroDoPr: 63,
  ciState: 'green',
  vereditoDoQa: 'approve',
  diffTruncado: false,
  delegado: true,
  shaRevisado: 'abc123',
  shaAtual: 'abc123',
}

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

  // Task 9, porteiro 1: mesmo que o juiz tenha aprovado, verificação esteja
  // verde e o diff completo, uma entrega de HUMANO nunca pode ser mesclada
  // sozinha pelo produto — é exatamente o quase-acidente do PR #99 (citação
  // de issue confundida com entrega do dev assíncrono), agora travado também
  // na porta do merge.
  it('recusa merge de entrega não encomendada pelo produto', async () => {
    let chamado = false
    const r = await mesclarPr({
      ...base,
      delegado: false,
      merge: async () => {
        chamado = true
        return true
      },
    })
    expect(chamado).toBe(false)
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toMatch(/não foi encomendad/i)
  })

  // Task 9, porteiro 2: o juiz aprovou UM commit específico. Se o dev
  // empurrou algo novo entre a aprovação e o merge, o código que entraria não
  // é o que foi revisado — aprovação não se transfere para código que
  // ninguém leu.
  it('recusa merge quando o código mudou depois da aprovação', async () => {
    let chamado = false
    const r = await mesclarPr({
      ...base,
      shaAtual: 'def456',
      merge: async () => {
        chamado = true
        return true
      },
    })
    expect(chamado).toBe(false)
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toMatch(/mudou depois/i)
  })

  it('mescla quando os cinco portões abrem', async () => {
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
})
