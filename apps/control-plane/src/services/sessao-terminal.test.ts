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

  // L4-T4, fix-up 5 (task a13a42f8-2953-4259-b41f-3f8cddb304cd) — PROVADO em
  // produção 03/09: 2 sessões com dúvida ESCALADA ao dono (`answeredHash`
  // `escalada:0:<hash>`) foram fechadas por este passo às 09:49:14, motivo
  // `pr-rejeitado-sem-retomada`, ANTES de a reconciliação rodar. A causa:
  // `varrerSessoesDoDev` sincroniza `state` do Jules remoto ANTES deste
  // passo no mesmo tique (scheduler.ts) — o Jules pode marcar a sessão como
  // COMPLETED/FAILED/CANCELLED mesmo com a dúvida ainda sem resposta do
  // dono, e o `estado` que chega aqui já não é mais AWAITING_USER_FEEDBACK.
  // `ehTerminal(state)` (fix-up 2) não segura nada nesse caso — o único jeito
  // de saber que o dono ainda não decidiu é a marca em `answeredHash`, que é
  // INDEPENDENTE do `estado` remoto. A partir de agora a marca de escalada
  // VETA o fechamento por este passo, seja qual for `estado`/`situacaoDoPr`.
  it('marca de escalada em answeredHash → mantém MESMO com PR rejeitado passado das 12h (cenário exato de produção)', () => {
    const d = decidirSessaoTerminal({
      ...base,
      situacaoDoPr: 'aberto-rejeitado-parado',
      horasNoTerminal: 13,
      answeredHash: 'escalada:0:abc123',
    })
    expect(d).toEqual({ acao: 'manter' })
  })

  it('marca de escalada em answeredHash → mantém mesmo FAILED sem PR (nunca fecha por este passo)', () => {
    const d = decidirSessaoTerminal({
      ...base,
      estado: 'FAILED',
      answeredHash: 'escalada:0:abc123',
    })
    expect(d).toEqual({ acao: 'manter' })
  })

  it('marca de escalada em answeredHash → mantém mesmo com PR mesclado (a escalada é absoluta)', () => {
    const d = decidirSessaoTerminal({
      ...base,
      situacaoDoPr: 'mesclado',
      answeredHash: 'escalada:0:abc123',
    })
    expect(d).toEqual({ acao: 'manter' })
  })

  it('marca "respondida" (não escalada) NÃO ativa o veto — segue a decisão normal', () => {
    const d = decidirSessaoTerminal({
      ...base,
      situacaoDoPr: 'aberto-rejeitado-parado',
      horasNoTerminal: 13,
      answeredHash: 'respondida:0:abc123',
    })
    expect(d).toEqual({ acao: 'fechar-e-redelegar', motivo: 'pr-rejeitado-sem-retomada' })
  })

  it('answeredHash ausente (null/undefined) NÃO ativa o veto — comportamento de sempre', () => {
    expect(
      decidirSessaoTerminal({ ...base, situacaoDoPr: 'mesclado', answeredHash: null })
    ).toEqual({ acao: 'fechar-concluido', motivo: 'merged' })
    expect(decidirSessaoTerminal({ ...base, situacaoDoPr: 'mesclado' })).toEqual({
      acao: 'fechar-concluido',
      motivo: 'merged',
    })
  })
})
