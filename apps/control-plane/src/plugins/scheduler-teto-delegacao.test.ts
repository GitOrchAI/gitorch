import { describe, expect, test } from 'vitest'
import { montarOpcoesDeDelegacao } from './scheduler.js'
import type { LinhaDeSessao } from '../services/dev-session-store.js'

// Achado 2 da revisão da Task 5: `montarOpcoesDeDelegacao` é a única ponte
// testável entre o plano do dev assíncrono declarado pelo dono
// (project.devPlan) e o teto que de fato chega em `runSmDelegation`. Antes
// da extração essa montagem vivia dentro de `executeMissionWithFailover`
// (closure não exportada) — uma regressão que reintroduzisse os literais
// `3`/`15` no lugar de `tetosDoPlanoDoDev` não quebraria teste nenhum, e o
// produto estouraria a cota do cliente em silêncio.
describe('montarOpcoesDeDelegacao', () => {
  const sessaoFake: LinhaDeSessao = {
    id: 'sessao-1',
    projectId: 'projeto-1',
    issueNumber: 42,
    sessionName: 'sessions/abc',
    state: 'aguardando',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 0,
    nudges: 0,
    lastProgressAt: null,
  } as LinhaDeSessao

  test('plano pro produz o teto do pro (15/100) — não o do free (3/15)', () => {
    const opcoes = montarOpcoesDeDelegacao({
      devPlan: 'pro',
      sessoesVivas: [],
      delegadasHoje: 0,
      entregasDoProjeto: [],
      vivasNaConta: 0,
    })
    expect(opcoes.tetoConcorrentes).toBe(15)
    expect(opcoes.tetoDiario).toBe(100)
  })

  test('plano free produz 3/15', () => {
    const opcoes = montarOpcoesDeDelegacao({
      devPlan: 'free',
      sessoesVivas: [],
      delegadasHoje: 0,
      entregasDoProjeto: [],
      vivasNaConta: 0,
    })
    expect(opcoes.tetoConcorrentes).toBe(3)
    expect(opcoes.tetoDiario).toBe(15)
  })

  test('devPlan nulo/ausente cai no padrão restritivo (3/15)', () => {
    expect(
      montarOpcoesDeDelegacao({
        devPlan: null,
        sessoesVivas: [],
        delegadasHoje: 0,
        entregasDoProjeto: [],
        vivasNaConta: 0,
      })
    ).toMatchObject({ tetoConcorrentes: 3, tetoDiario: 15 })
    expect(
      montarOpcoesDeDelegacao({
        devPlan: undefined,
        sessoesVivas: [],
        delegadasHoje: 0,
        entregasDoProjeto: [],
        vivasNaConta: 0,
      })
    ).toMatchObject({ tetoConcorrentes: 3, tetoDiario: 15 })
  })

  test('devPlan desconhecido (ex.: "enterprise") nunca produz um teto maior — cai no free', () => {
    const opcoes = montarOpcoesDeDelegacao({
      devPlan: 'enterprise',
      sessoesVivas: [],
      delegadasHoje: 0,
      entregasDoProjeto: [],
      vivasNaConta: 0,
    })
    expect(opcoes.tetoConcorrentes).toBe(3)
    expect(opcoes.tetoDiario).toBe(15)
  })

  test('sessoesVivas e delegadasHoje são repassados sem alteração', () => {
    const sessoesVivasArg = [sessaoFake]
    const opcoes = montarOpcoesDeDelegacao({
      devPlan: 'pro',
      sessoesVivas: sessoesVivasArg,
      delegadasHoje: 7,
      entregasDoProjeto: [],
      vivasNaConta: 0,
    })
    // Mesma referência: prova que a função não clona nem filtra a fila.
    expect(opcoes.sessoesVivas).toBe(sessoesVivasArg)
    expect(opcoes.delegadasHoje).toBe(7)
  })
})
