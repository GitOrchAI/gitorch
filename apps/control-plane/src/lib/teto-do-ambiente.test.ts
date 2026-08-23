import { describe, expect, it } from 'vitest'
import { tetoDoAmbiente } from './teto-do-ambiente.js'

// O seed roda a CADA deploy e faz upsert dos quatro planos. Quando o dono subiu
// o teto do plano à mão no banco, para destravar a prova ponta a ponta, o
// próximo deploy apagaria a mudança dele em silêncio — e a esteira voltaria a
// travar sem ninguém entender por quê.

const PADRAO = { maxMissionsPerDay: 90, maxConcurrentMissions: 2 }

describe('tetoDoAmbiente', () => {
  it('sem variável, o padrão do PRODUTO manda', () => {
    expect(tetoDoAmbiente('pro', PADRAO, {})).toEqual(PADRAO)
  })

  it('com variável, o ambiente sobrepõe', () => {
    const r = tetoDoAmbiente('pro', PADRAO, {
      GITORCH_PLANO_PRO_MISSOES_POR_DIA: '1000',
      GITORCH_PLANO_PRO_CONCORRENTES: '4',
    })
    expect(r).toEqual({ maxMissionsPerDay: 1000, maxConcurrentMissions: 4 })
  })

  it('as duas são independentes — dá para subir só o teto do dia', () => {
    const r = tetoDoAmbiente('pro', PADRAO, { GITORCH_PLANO_PRO_MISSOES_POR_DIA: '500' })
    expect(r).toEqual({ maxMissionsPerDay: 500, maxConcurrentMissions: 2 })
  })

  it('a variável é POR PLANO — a do pro não mexe no team', () => {
    const r = tetoDoAmbiente('team', PADRAO, { GITORCH_PLANO_PRO_MISSOES_POR_DIA: '1000' })
    expect(r).toEqual(PADRAO)
  })

  it('valor INVÁLIDO é ignorado com aviso, nunca aplicado', () => {
    // `Number('')` é zero e `Number('abc')` é NaN. Sem esta guarda, uma
    // variável vazia zeraria o teto e calaria a esteira inteira — o oposto do
    // que esta sobreposição existe para fazer. Mesmo erro que já custou caro
    // na cadência da reconciliação.
    const avisos: string[] = []
    for (const ruim of ['', 'abc', '0', '-5']) {
      const r = tetoDoAmbiente('pro', PADRAO, { GITORCH_PLANO_PRO_MISSOES_POR_DIA: ruim }, (m) =>
        avisos.push(m)
      )
      expect(r.maxMissionsPerDay).toBe(90)
    }
    expect(avisos).toHaveLength(4)
  })

  it('o aviso DIZ qual variável e qual valor — senão ninguém acha', () => {
    const avisos: string[] = []
    tetoDoAmbiente('pro', PADRAO, { GITORCH_PLANO_PRO_CONCORRENTES: 'xis' }, (m) => avisos.push(m))
    expect(avisos[0]).toContain('GITORCH_PLANO_PRO_CONCORRENTES')
    expect(avisos[0]).toContain('xis')
  })
})
