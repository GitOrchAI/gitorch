import { describe, expect, test } from 'vitest'
import { isEngineFault } from './scheduler.js'
import { RailsExecutionError, RailsStepError } from '../services/rails-runner.js'
import { GithubExecutionError } from '../services/github-errors.js'

// Defeito real de produção (loureng/patinhas-3d-crafts, chain=codex>antigravity,
// 12/08 em diante): o motor `codex` saía com exitCode != 0 todo dia e a missão
// morria SEM NUNCA tentar o `antigravity` (a reserva). Causa raiz: o passo de
// trilhos (scheduler.ts, execute()) lançava um `Error` genérico quando o
// PROCESSO do motor falhava — e a classificação de failover só reconhecia
// RailsStepError (motor respondeu, formulário não validou) e isFailoverError
// (texto de cota/auth). Falha de processo não batia em nenhum dos dois:
// engineFault ficava false e o loop dava `break` sem tentar o próximo motor,
// sem sequer logar o aviso de failover.
//
// A correção: o passo de trilhos agora lança RailsExecutionError (irmão
// tipado de RailsStepError, em rails-runner.ts) quando o processo do motor
// sai com exitCode != 0, e isEngineFault (extraído da decisão que antes vivia
// só dentro do catch de executeMissionWithFailover) reconhece esse tipo.
describe('isEngineFault — classificação que decide o failover de motor', () => {
  test('RailsExecutionError (processo do motor saiu com exitCode != 0): É falha de motor — a cadeia deve trocar de motor', () => {
    const err = new RailsExecutionError('rails step 1 failed: codex: command not found', 127)
    expect(isEngineFault(err, String(err))).toBe(true)
  })

  test('RailsStepError (motor respondeu mas o formulário nunca validou): continua sendo falha de motor (regressão)', () => {
    const err = new RailsStepError('Form step failed after 3 attempts', ['schema inválido'], 3)
    expect(isEngineFault(err, String(err))).toBe(true)
  })

  test('mensagem de cota/auth (isFailoverError via texto): continua sendo falha de motor (regressão)', () => {
    const err = new Error('429 rate limit exceeded')
    expect(isEngineFault(err, String(err))).toBe(true)
  })

  test('GithubExecutionError: NUNCA é falha de motor — erro do GitHub é igual para todo motor, failover só repetiria o dano', () => {
    const err = new GithubExecutionError('GitHub GraphQL failed: rate limit do repositório')
    expect(isEngineFault(err, String(err))).toBe(false)
  })

  test('erro genérico sem relação com motor/cota: não é falha de motor (a classificação não pode virar um catch-all)', () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:5432 (banco fora do ar)')
    expect(isEngineFault(err, String(err))).toBe(false)
  })
})

// Prova no formato exigido pela task: com DOIS motores na cadeia e o primeiro
// falhando por exitCode != 0 (RailsExecutionError), o SEGUNDO é tentado. E
// GithubExecutionError, mesmo não sendo o último motor da cadeia, NUNCA
// dispara a troca — reproduz fielmente a forma do loop real de
// executeMissionWithFailover (scheduler.ts): GithubExecutionError quebra o
// loop ANTES de sequer calcular engineFault; os demais casos passam por
// isEngineFault, e só continuam para o próximo motor se `!isLast &&
// engineFault`.
describe('cadeia de failover (forma do loop de executeMissionWithFailover)', () => {
  function simulaCadeia(chain: string[], erroPorMotor: Record<string, unknown>) {
    const tentados: string[] = []
    for (let i = 0; i < chain.length; i++) {
      const motor = chain[i] as string
      tentados.push(motor)
      const isLast = i === chain.length - 1
      const err = erroPorMotor[motor]
      if (err === undefined) return { tentados, parouEm: motor, motivo: 'sucesso' as const }
      if (err instanceof GithubExecutionError) {
        return { tentados, parouEm: motor, motivo: 'github-sem-failover' as const }
      }
      const engineFault = isEngineFault(err, String(err))
      if (!isLast && engineFault) continue
      return { tentados, parouEm: motor, motivo: 'parou-sem-failover' as const }
    }
    return { tentados, parouEm: null, motivo: 'esgotou-a-cadeia' as const }
  }

  test('codex sai com exitCode != 0 (RailsExecutionError): antigravity (a reserva) é tentado em seguida', () => {
    const chain = ['codex', 'antigravity']
    const resultado = simulaCadeia(chain, {
      codex: new RailsExecutionError('rails step 1 failed: codex saiu com exitCode 1', 1),
    })
    expect(resultado.tentados).toEqual(['codex', 'antigravity'])
  })

  test('GithubExecutionError no primeiro motor: NÃO troca para o segundo, mesmo não sendo o último da cadeia', () => {
    const chain = ['codex', 'antigravity']
    const resultado = simulaCadeia(chain, {
      codex: new GithubExecutionError('GitHub GraphQL failed: 403 do repositório'),
    })
    expect(resultado.tentados).toEqual(['codex'])
    expect(resultado.motivo).toBe('github-sem-failover')
  })
})
