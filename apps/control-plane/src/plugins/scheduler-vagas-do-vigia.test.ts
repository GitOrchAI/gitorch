import { describe, expect, test } from 'vitest'
import { vagasLivresDoVigia } from './scheduler.js'

// Achado real 30/09: padrao-executores tem dev_plan nulo e dividia a MESMA
// conta do dev com dois projetos 'pro' (15). O vigia contava o teto do
// projeto -> 'free' (3) e dizia "sem vaga na conta do dev" com só 3 linhas
// abertas. O teto é da CONTA, como já é na delegação.
describe('vagasLivresDoVigia', () => {
  test('projeto sem plano declarado herda o efetivo da conta (pro=15), não o free (3)', () => {
    expect(
      vagasLivresDoVigia({
        devPlanDoProjeto: null,
        devPlansDaConta: ['pro', 'pro', null],
        ocupadasNaConta: 3,
      })
    ).toBe(12)
  })

  test('com o teto do free (bug antigo) as mesmas 3 linhas dariam 0 vagas — agora não', () => {
    const vagas = vagasLivresDoVigia({
      devPlanDoProjeto: '',
      devPlansDaConta: ['pro', 'pro', null],
      ocupadasNaConta: 3,
    })
    expect(vagas).toBeGreaterThan(0)
  })

  test('plano próprio declarado vale: pro com 15 ocupadas → 0', () => {
    expect(
      vagasLivresDoVigia({
        devPlanDoProjeto: 'pro',
        devPlansDaConta: [],
        ocupadasNaConta: 15,
      })
    ).toBe(0)
  })

  test('conta com um projeto free declarado: o mais restritivo vence (3)', () => {
    expect(
      vagasLivresDoVigia({
        devPlanDoProjeto: null,
        devPlansDaConta: ['pro', 'free', null],
        ocupadasNaConta: 1,
      })
    ).toBe(2)
  })

  test('sem nenhum plano declarado na conta → free (3), o padrão seguro', () => {
    expect(
      vagasLivresDoVigia({
        devPlanDoProjeto: null,
        devPlansDaConta: [null, null],
        ocupadasNaConta: 0,
      })
    ).toBe(3)
  })

  test('ocupadas acima do teto nunca dá vaga negativa', () => {
    expect(
      vagasLivresDoVigia({
        devPlanDoProjeto: 'free',
        devPlansDaConta: [],
        ocupadasNaConta: 9,
      })
    ).toBe(0)
  })
})
