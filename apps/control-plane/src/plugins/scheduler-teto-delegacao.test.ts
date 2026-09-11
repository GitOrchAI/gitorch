import { describe, expect, test } from 'vitest'
import { montarOpcoesDeDelegacao, devPlanParaDelegacao } from './scheduler.js'
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
      ocupamVagaNaConta: 0,
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
      ocupamVagaNaConta: 0,
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
        ocupamVagaNaConta: 0,
      })
    ).toMatchObject({ tetoConcorrentes: 3, tetoDiario: 15 })
    expect(
      montarOpcoesDeDelegacao({
        devPlan: undefined,
        sessoesVivas: [],
        delegadasHoje: 0,
        entregasDoProjeto: [],
        vivasNaConta: 0,
        ocupamVagaNaConta: 0,
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
      ocupamVagaNaConta: 0,
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
      ocupamVagaNaConta: 0,
    })
    // Mesma referência: prova que a função não clona nem filtra a fila.
    expect(opcoes.sessoesVivas).toBe(sessoesVivasArg)
    expect(opcoes.delegadasHoje).toBe(7)
  })

  test('ocupamVagaNaConta é repassado — é ele que o teto de simultâneas usa', () => {
    const opcoes = montarOpcoesDeDelegacao({
      devPlan: 'pro',
      sessoesVivas: [],
      delegadasHoje: 0,
      entregasDoProjeto: [],
      vivasNaConta: 23,
      ocupamVagaNaConta: 2,
    })
    // vivasNaConta (23, incluindo as COMPLETED) fica só para log; quem conta
    // contra o teto de simultâneas é ocupamVagaNaConta (2).
    expect(opcoes.vivasNaConta).toBe(23)
    expect(opcoes.ocupamVagaNaConta).toBe(2)
  })
})

// DJ-T5b — dados reais de produção: gitorch e patinhas-3d-crafts têm devPlan
// 'pro'; padrao-executores NÃO TEM devPlan — os três dividem a mesma conta
// do dev assíncrono. `devPlanParaDelegacao` é a ponte pura entre o plano
// próprio do projeto (ou a ausência dele) e o plano que de fato entra em
// `montarOpcoesDeDelegacao` — sem ela, o projeto sem plano herdava um
// 'free' fixo mesmo estando numa conta Pro real.
describe('devPlanParaDelegacao', () => {
  test('projeto com plano próprio declarado usa o seu, ignorando os da conta', () => {
    expect(devPlanParaDelegacao('free', ['pro', 'pro'])).toBe('free')
  })

  test('projeto sem plano numa conta com outro pro herda pro — não inventa free', () => {
    expect(devPlanParaDelegacao(null, ['pro', null])).toBe('pro')
  })

  test('projeto sem plano e conta também sem nenhum declarado cai no free', () => {
    expect(devPlanParaDelegacao(null, [null])).toBe('free')
  })

  test('ponta a ponta: projeto sem plano numa conta pro produz o teto 15/100 na delegação', () => {
    const devPlan = devPlanParaDelegacao(null, ['pro', 'pro', null])
    const opcoes = montarOpcoesDeDelegacao({
      devPlan,
      sessoesVivas: [],
      delegadasHoje: 0,
      entregasDoProjeto: [],
      vivasNaConta: 0,
      ocupamVagaNaConta: 0,
    })
    expect(opcoes.tetoConcorrentes).toBe(15)
    expect(opcoes.tetoDiario).toBe(100)
  })
})
