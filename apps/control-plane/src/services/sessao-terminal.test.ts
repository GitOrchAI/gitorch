import { describe, it, expect } from 'vitest'
import { decidirSessaoTerminal } from './sessao-terminal.js'

const base = {
  estado: 'COMPLETED',
  situacaoDoPr: 'sem-pr' as const,
  requeueCount: 0,
  analiseJaFeita: false,
  horasNoTerminal: 0,
}

describe('decidirSessaoTerminal', () => {
  it('não-terminal → mantém (não é assunto deste passo)', () => {
    expect(decidirSessaoTerminal({ ...base, estado: 'IN_PROGRESS' })).toEqual({ acao: 'manter' })
    expect(decidirSessaoTerminal({ ...base, estado: 'AWAITING_USER_FEEDBACK' })).toEqual({
      acao: 'manter',
    })
  })

  it('COMPLETED + PR mesclado → fecha como concluído', () => {
    expect(decidirSessaoTerminal({ ...base, situacaoDoPr: 'mesclado' })).toEqual({
      acao: 'fechar-concluido',
      motivo: 'merged',
    })
  })

  it('COMPLETED + PR aberto e vivo → mantém (o QA cuida)', () => {
    expect(
      decidirSessaoTerminal({ ...base, situacaoDoPr: 'aberto-vivo', horasNoTerminal: 48 })
    ).toEqual({ acao: 'manter' })
  })

  it('COMPLETED sem PR, 1ª vez → fecha e redelega', () => {
    expect(decidirSessaoTerminal(base)).toEqual({
      acao: 'fechar-e-redelegar',
      motivo: 'dev-concluiu-sem-entrega',
    })
  })

  it('FAILED sem PR, 1ª vez → fecha e redelega (motivo dev-falhou)', () => {
    expect(decidirSessaoTerminal({ ...base, estado: 'FAILED' })).toEqual({
      acao: 'fechar-e-redelegar',
      motivo: 'dev-falhou',
    })
  })

  it('CANCELLED conta como terminal', () => {
    expect(decidirSessaoTerminal({ ...base, estado: 'CANCELLED' }).acao).toBe('fechar-e-redelegar')
  })

  it('2ª falha na mesma issue, análise ainda não feita → fecha e analisa', () => {
    expect(
      decidirSessaoTerminal({ ...base, estado: 'FAILED', requeueCount: 2, analiseJaFeita: false })
    ).toEqual({ acao: 'fechar-e-analisar', motivo: 'dev-falhou' })
  })

  it('requeueCount 2 mas análise JÁ feita → fecha e redelega (é a 3ª tentativa)', () => {
    expect(decidirSessaoTerminal({ ...base, requeueCount: 2, analiseJaFeita: true }).acao).toBe(
      'fechar-e-redelegar'
    )
  })

  it('requeueCount 3 (já passou da análise) → só redelega, não re-analisa', () => {
    expect(decidirSessaoTerminal({ ...base, requeueCount: 3, analiseJaFeita: true }).acao).toBe(
      'fechar-e-redelegar'
    )
  })

  it('PR fechado sem merge → fecha e redelega (pr-descartado)', () => {
    expect(decidirSessaoTerminal({ ...base, situacaoDoPr: 'fechado-sem-merge' })).toEqual({
      acao: 'fechar-e-redelegar',
      motivo: 'pr-descartado',
    })
  })

  it('PR aberto rejeitado, ainda dentro das 12h → mantém (dá tempo do dev retrabalhar)', () => {
    expect(
      decidirSessaoTerminal({
        ...base,
        situacaoDoPr: 'aberto-rejeitado-parado',
        horasNoTerminal: 5,
      })
    ).toEqual({ acao: 'manter' })
  })

  it('PR aberto rejeitado, passou das 12h e o Jules está terminal → fecha e redelega', () => {
    const d = decidirSessaoTerminal({
      ...base,
      situacaoDoPr: 'aberto-rejeitado-parado',
      horasNoTerminal: 13,
    })
    expect(d).toEqual({ acao: 'fechar-e-redelegar', motivo: 'pr-rejeitado-sem-retomada' })
  })

  it('PR rejeitado + passou das 12h + é a 2ª falha → analisa antes da 3ª', () => {
    const d = decidirSessaoTerminal({
      ...base,
      situacaoDoPr: 'aberto-rejeitado-parado',
      horasNoTerminal: 20,
      requeueCount: 2,
    })
    expect(d).toEqual({ acao: 'fechar-e-analisar', motivo: 'pr-rejeitado-sem-retomada' })
  })

  // ── L4-T5: retomada no MESMO PR ───────────────────────────────────────────
  //
  // Medido: issue #3884 do Jardim, 5 sessões e 3 PRs para UMA task. Fechar e
  // devolver a issue à fila abre um SEGUNDO pull request do zero; com um ramo
  // retomável a esteira tenta de novo NO MESMO PR em vez disso.
  describe('retomada no mesmo PR (L4-T5)', () => {
    it('PR rejeitado, passou das 12h, HÁ ramo retomável → retomar-no-mesmo-pr', () => {
      const d = decidirSessaoTerminal({
        ...base,
        situacaoDoPr: 'aberto-rejeitado-parado',
        horasNoTerminal: 13,
        branchRetomavel: 'jules-3917-branch',
      })
      expect(d).toEqual({ acao: 'retomar-no-mesmo-pr', branchDoPr: 'jules-3917-branch' })
    })

    it('ainda dentro das 12h, mesmo com ramo retomável → mantém (dá tempo)', () => {
      const d = decidirSessaoTerminal({
        ...base,
        situacaoDoPr: 'aberto-rejeitado-parado',
        horasNoTerminal: 5,
        branchRetomavel: 'jules-3917-branch',
      })
      expect(d).toEqual({ acao: 'manter' })
    })

    it('SEM ramo retomável (fork, ausente) → cai no comportamento antigo (fecha e redelega)', () => {
      const d = decidirSessaoTerminal({
        ...base,
        situacaoDoPr: 'aberto-rejeitado-parado',
        horasNoTerminal: 13,
        branchRetomavel: null,
      })
      expect(d).toEqual({ acao: 'fechar-e-redelegar', motivo: 'pr-rejeitado-sem-retomada' })
    })

    it('branchRetomavel AUSENTE (chamador antigo) → comportamento antigo preservado', () => {
      const d = decidirSessaoTerminal({
        ...base,
        situacaoDoPr: 'aberto-rejeitado-parado',
        horasNoTerminal: 13,
      })
      expect(d).toEqual({ acao: 'fechar-e-redelegar', motivo: 'pr-rejeitado-sem-retomada' })
    })

    it('ramo retomável mas situação é OUTRA (não é PR rejeitado) → ignora o ramo', () => {
      const d = decidirSessaoTerminal({
        ...base,
        situacaoDoPr: 'fechado-sem-merge',
        branchRetomavel: 'jules-3917-branch',
      })
      expect(d).toEqual({ acao: 'fechar-e-redelegar', motivo: 'pr-descartado' })
    })
  })
})
