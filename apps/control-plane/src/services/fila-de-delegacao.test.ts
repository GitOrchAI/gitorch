import { describe, it, expect } from 'vitest'
import { escolherParaDelegar, type IssueCandidata } from './fila-de-delegacao.js'
import type { LinhaDeSessao } from './dev-session-store.js'

function linha(over: Partial<LinhaDeSessao>): LinhaDeSessao {
  return {
    id: 'x',
    projectId: 'p1',
    issueNumber: 1,
    sessionName: 's1',
    state: 'IN_PROGRESS',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    ...over,
  }
}
function issue(over: Partial<IssueCandidata>): IssueCandidata {
  return { number: 1, bloqueadoresAbertos: 0, ...over }
}
const base = { delegadasHoje: 0, tetoConcorrentes: 15, tetoDiario: 100, capPorCiclo: 3 }

describe('escolherParaDelegar', () => {
  it('escolhe issue que nunca teve sessão', () => {
    expect(
      escolherParaDelegar({ ...base, candidatas: [issue({ number: 10 })], sessoesVivas: [] })
    ).toEqual([10])
  })

  it('NÃO escolhe issue que já tem sessão viva', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10 })],
        sessoesVivas: [linha({ issueNumber: 10 })],
      })
    ).toEqual([])
  })

  it('ESCOLHE de novo issue cuja sessão morreu — a etiqueta prendia para sempre', () => {
    // #46, #47 e #48 foram delegadas, o trabalho morreu, e como carregavam a
    // etiqueta nunca voltaram para a fila. Pela linha, sessão fechada sem merge
    // devolve a issue para a fila.
    expect(
      escolherParaDelegar({ ...base, candidatas: [issue({ number: 46 })], sessoesVivas: [] })
    ).toEqual([46])
  })

  it('não escolhe issue com bloqueador aberto', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10, bloqueadoresAbertos: 1 })],
        sessoesVivas: [],
      })
    ).toEqual([])
  })

  it('respeita o teto de sessões concorrentes do plano', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10 }), issue({ number: 11 })],
        sessoesVivas: [
          linha({ issueNumber: 1 }),
          linha({ issueNumber: 2 }),
          linha({ issueNumber: 3 }),
        ],
        tetoConcorrentes: 3,
        tetoDiario: 15,
      })
    ).toEqual([])
  })

  it('respeita o teto diário do plano', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10 }), issue({ number: 11 })],
        sessoesVivas: [],
        delegadasHoje: 15,
        tetoConcorrentes: 3,
        tetoDiario: 15,
      })
    ).toEqual([])
  })

  it('preenche só até a folga do teto de concorrentes', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10 }), issue({ number: 11 }), issue({ number: 12 })],
        sessoesVivas: [linha({ issueNumber: 1 })],
        tetoConcorrentes: 3,
      })
    ).toEqual([10, 11])
  })

  it('respeita o teto por ciclo mesmo com folga de plano', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [10, 11, 12, 13].map((n) => issue({ number: n })),
        sessoesVivas: [],
        tetoConcorrentes: 60,
        tetoDiario: 300,
      })
    ).toEqual([10, 11, 12])
  })

  it('mantém a ordem recebida — a ordem da sprint decide a prioridade', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 30 }), issue({ number: 10 }), issue({ number: 20 })],
        sessoesVivas: [],
        capPorCiclo: 2,
      })
    ).toEqual([30, 10])
  })
})
