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
  entendimentoPresente: true,
  baseDoPr: 'main',
  branchPadrao: 'main',
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

  it('recusa mesclar quando o veredito aprovou mas não veio com entendimento (Fase 3.8)', async () => {
    const resultado = await mesclarPr({
      ...base,
      entendimentoPresente: false,
      merge: async () => true,
    })
    expect(resultado).toEqual({
      mesclado: false,
      motivo: 'o QA aprovou sem registrar o entendimento do pedido',
    })
  })

  it('mescla quando os 3 critérios batem, entendimento incluído', async () => {
    const resultado = await mesclarPr({
      ...base,
      entendimentoPresente: true,
      merge: async () => true,
    })
    expect(resultado.mesclado).toBe(true)
  })
})

describe('mesclarPr — só mescla PR que MIRA a branch padrão do projeto', () => {
  it('PR com base num ramo antigo NÃO é mesclado (mesclagem falsa, medido em 30/09)', async () => {
    let chamado = false
    const r = await mesclarPr({
      ...base,
      baseDoPr: 'fix-refactor-conflict-verification-1',
      merge: async () => {
        chamado = true
        return true
      },
    })
    expect(chamado).toBe(false)
    expect(r.mesclado).toBe(false)
    // Motivo em português de negócio: diz o ramo, a principal e que precisa de gente.
    expect(r.motivo).toContain('fix-refactor-conflict-verification-1')
    expect(r.motivo).toContain('`main`')
    expect(r.motivo).toMatch(/julgamento humano/)
  })

  it('base desconhecida (null) NÃO é mesclada: na dúvida, não mescla', async () => {
    let chamado = false
    const r = await mesclarPr({
      ...base,
      baseDoPr: null,
      merge: async () => {
        chamado = true
        return true
      },
    })
    expect(chamado).toBe(false)
    expect(r.mesclado).toBe(false)
    expect(r.motivo).toMatch(/não deu para confirmar/)
  })

  it('compara com a branch padrão DO PROJETO (develop), não com "main" fixo', async () => {
    const naPadrao = await mesclarPr({
      ...base,
      baseDoPr: 'develop',
      branchPadrao: 'develop',
      merge: async () => true,
    })
    expect(naPadrao.mesclado).toBe(true)
    const naMain = await mesclarPr({
      ...base,
      baseDoPr: 'main',
      branchPadrao: 'develop',
      merge: async () => true,
    })
    expect(naMain.mesclado).toBe(false)
  })
})
