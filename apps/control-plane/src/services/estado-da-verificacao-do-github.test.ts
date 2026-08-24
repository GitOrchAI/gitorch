import { describe, it, expect } from 'vitest'
import { estadoDoCi, ciTerminouVerde } from './estado-da-verificacao-do-github.js'

const ok = (nome = 'x') => ({ status: 'completed', conclusion: 'success', nome })

describe('estadoDoCi', () => {
  it('tudo verde é verde', () => {
    expect(estadoDoCi([ok(), ok()])).toBe('green')
  })

  // O caso REAL que travou o patinhas por quatro dias: PR #3788, 16 jobs
  // passando e 3 condicionais pulados ("Corrigir conflito de merge",
  // "Dependabot version update", "Mermaid Diagram Sync"). O QA leu vermelho e
  // reprovou uma entrega boa.
  it('job PULADO não é job falhado — era o defeito do patinhas', () => {
    const comoNoPr3788 = [
      ...Array.from({ length: 16 }, () => ok()),
      { status: 'completed', conclusion: 'skipped' },
      { status: 'completed', conclusion: 'skipped' },
      { status: 'completed', conclusion: 'skipped' },
    ]
    expect(estadoDoCi(comoNoPr3788)).toBe('green')
  })

  it('neutral continua não reprovando', () => {
    expect(estadoDoCi([ok(), { status: 'completed', conclusion: 'neutral' }])).toBe('green')
  })

  it('falha de verdade continua vermelha', () => {
    expect(estadoDoCi([ok(), { status: 'completed', conclusion: 'failure' }])).toBe('red')
  })

  // Cada um destes é uma forma de "não sei se passa", e aprovar sobre eles
  // seria aprovar sobre um teste que não terminou.
  it.each(['cancelled', 'timed_out', 'action_required', 'stale'])(
    'conclusão "%s" reprova',
    (conclusao) => {
      expect(estadoDoCi([ok(), { status: 'completed', conclusion: conclusao }])).toBe('red')
    }
  )

  it('conclusão desconhecida reprova: o produto não inventa que passou', () => {
    expect(estadoDoCi([ok(), { status: 'completed', conclusion: 'algo_novo_do_github' }])).toBe(
      'red'
    )
  })

  it('conclusão ausente num check terminado reprova', () => {
    expect(estadoDoCi([ok(), { status: 'completed' }])).toBe('red')
  })

  it('qualquer job ainda rodando é "pending", não vermelho', () => {
    expect(estadoDoCi([ok(), { status: 'in_progress' }])).toBe('pending')
    expect(estadoDoCi([{ status: 'queued' }])).toBe('pending')
  })

  // "pending" ganha de "red": o job que falhou pode ser justamente o que vai
  // rodar de novo, e reprovar antes do fim é o defeito que já prendeu o PR #97.
  it('rodando ainda, com um já falhado, continua "pending"', () => {
    expect(
      estadoDoCi([{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }])
    ).toBe('pending')
  })

  it('repositório sem verificação nenhuma é "no checks", que é estado estável', () => {
    expect(estadoDoCi([])).toBe('no checks')
  })
})

describe('ciTerminouVerde', () => {
  it('só é verdade quando terminou e passou', () => {
    expect(ciTerminouVerde([ok(), { status: 'completed', conclusion: 'skipped' }])).toBe(true)
    expect(ciTerminouVerde([ok(), { status: 'in_progress' }])).toBe(false)
    expect(ciTerminouVerde([{ status: 'completed', conclusion: 'failure' }])).toBe(false)
  })

  // Lista vazia não é verde: é "não sei". Reabrir um veredito sobre isso seria
  // opinar duas vezes no pull request do cliente sem base.
  it('sem check nenhum NÃO conta como verde para rejulgar', () => {
    expect(ciTerminouVerde([])).toBe(false)
  })
})
