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
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
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

// ── Duas tarefas no mesmo arquivo (item 4 do plano) ────────────────────────
//
// O produto delegou duas tarefas que tocavam o mesmo arquivo e CRIOU O PRÓPRIO
// CONFLITO de merge — depois gastou ciclos tentando resolver um problema que
// ele mesmo tinha fabricado. A fila só respeitava dependência DECLARADA no
// corpo da issue ("Blocked by #N"); ela não olhava o que cada tarefa ia tocar.
//
// O RISCO DESTE CONSERTO é o oposto do defeito: travar a fila por excesso de
// zelo. Tarefa sem arquivo declarado não pode ser bloqueada por isso — lista
// vazia significa "não sei", não "nenhum arquivo" —, e o cruzamento só vale
// dentro do MESMO ciclo, nunca para sempre. Os dois casos têm teste próprio.
describe('escolherParaDelegar: não delegar duas tarefas no mesmo arquivo', () => {
  const semTeto = {
    sessoesVivas: [],
    delegadasHoje: 0,
    tetoConcorrentes: 10,
    tetoDiario: 10,
    capPorCiclo: 10,
  }

  it('duas candidatas com arquivo em comum: só a PRIMEIRA entra neste ciclo', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0, arquivos: ['src/a.ts', 'src/b.ts'] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: ['src/b.ts'] },
      ],
    })
    // A segunda não é descartada: ela espera. No ciclo seguinte, com a primeira
    // já com sessão viva, ela entra normalmente.
    expect(escolhidas).toEqual([1])
  })

  it('a ordem da sprint é respeitada — quem chega antes tem o arquivo', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 9, bloqueadoresAbertos: 0, arquivos: ['src/x.ts'] },
        { number: 3, bloqueadoresAbertos: 0, arquivos: ['src/x.ts'] },
      ],
    })
    expect(escolhidas).toEqual([9])
  })

  it('arquivos DIFERENTES: as duas entram, como sempre entraram', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: ['src/b.ts'] },
      ],
    })
    expect(escolhidas).toEqual([1, 2])
  })

  it('SEM arquivo declarado, nada é bloqueado — "não sei" não é "conflita"', () => {
    // A guarda contra travar a fila por falta de informação. Se o PO não
    // declarou arquivos, a fila tem que andar exatamente como andava antes.
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0, arquivos: [] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: [] },
        { number: 3, bloqueadoresAbertos: 0, arquivos: [] },
      ],
    })
    expect(escolhidas).toEqual([1, 2, 3])
  })

  it('uma declara e a outra não: a que não declara passa', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: [] },
      ],
    })
    expect(escolhidas).toEqual([1, 2])
  })

  it('o campo é OPCIONAL: candidata sem ele se comporta como sem arquivo', () => {
    // Guarda de compatibilidade — nenhum chamador antigo quebra por não saber
    // do campo novo.
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0 },
        { number: 2, bloqueadoresAbertos: 0 },
      ],
    })
    expect(escolhidas).toEqual([1, 2])
  })

  it('a terceira ainda entra se o arquivo dela é livre', () => {
    // O bloqueio é por ARQUIVO, não "para o ciclo": barrar a segunda não pode
    // barrar quem vem depois dela sem nenhuma relação.
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
        { number: 3, bloqueadoresAbertos: 0, arquivos: ['src/c.ts'] },
      ],
    })
    expect(escolhidas).toEqual([1, 3])
  })

  it('a candidata barrada por arquivo NÃO consome vaga do teto', () => {
    // Se consumisse, uma colisão gastaria a cota do dia sem ninguém trabalhar
    // — a mesma classe de defeito do teto que contava acordada em falso.
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      capPorCiclo: 2,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
        { number: 3, bloqueadoresAbertos: 0, arquivos: ['src/c.ts'] },
      ],
    })
    expect(escolhidas).toEqual([1, 3])
  })

  it('bloqueador declarado continua mandando mais que o arquivo', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [
        { number: 1, bloqueadoresAbertos: 1, arquivos: ['src/a.ts'] },
        { number: 2, bloqueadoresAbertos: 0, arquivos: ['src/a.ts'] },
      ],
    })
    // A primeira está bloqueada e sai da conta; a segunda entra e o arquivo
    // dela fica livre, porque ninguém antes o reservou.
    expect(escolhidas).toEqual([2])
  })
})

// ── O achado ALTO da lente: o conflito espalhado entre dois ciclos ─────────
//
// A reserva por ciclo não bastava. Quem tem sessão viva é filtrado das
// candidatas ANTES de chegar aqui, então os arquivos de quem já está
// trabalhando sumiam da reserva. A tarefa A é delegada hoje mexendo em
// `src/x.ts` e fica dias rodando; amanhã a tarefa B, que também declara
// `src/x.ts`, é delegada numa acordada em que A nem aparece — e as duas mexem
// no mesmo arquivo ao mesmo tempo. O conflito de merge é fabricado de novo, só
// que mais difícil de enxergar do que o original.
describe('escolherParaDelegar: arquivo já EM TRABALHO também é reservado', () => {
  const semTeto = {
    sessoesVivas: [],
    delegadasHoje: 0,
    tetoConcorrentes: 10,
    tetoDiario: 10,
    capPorCiclo: 10,
  }

  it('não delega para um arquivo que uma sessão viva já está mexendo', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      arquivosEmTrabalho: ['src/x.ts'],
      candidatas: [{ number: 7, bloqueadoresAbertos: 0, arquivos: ['src/x.ts'] }],
    })
    expect(escolhidas).toEqual([])
  })

  it('arquivo em trabalho diferente não atrapalha ninguém', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      arquivosEmTrabalho: ['src/outro.ts'],
      candidatas: [{ number: 7, bloqueadoresAbertos: 0, arquivos: ['src/x.ts'] }],
    })
    expect(escolhidas).toEqual([7])
  })

  it('quem não declarou arquivo continua passando, mesmo com trabalho em curso', () => {
    // A guarda contra travar a fila: "não sei" nunca é "conflita".
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      arquivosEmTrabalho: ['src/x.ts'],
      candidatas: [{ number: 7, bloqueadoresAbertos: 0, arquivos: [] }],
    })
    expect(escolhidas).toEqual([7])
  })

  it('o campo é opcional — chamador antigo não muda de comportamento', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [{ number: 7, bloqueadoresAbertos: 0, arquivos: ['src/x.ts'] }],
    })
    expect(escolhidas).toEqual([7])
  })
})

describe('o teto de simultâneas é da CONTA, não do projeto', () => {
  const candidata = (n: number) => ({ number: n, bloqueadoresAbertos: 0 })

  // O caso medido em 25/08: dois projetos "pro", cada um se achando com 15
  // vagas, contra 15 no total da conta. Foi assim que o produto pediu mais do
  // que existia e levou mais de cem recusas num dia.
  it('vagas ocupadas por OUTRO projeto da mesma conta travam este', () => {
    const escolhidas = escolherParaDelegar({
      candidatas: [candidata(1), candidata(2)],
      sessoesVivas: [],
      // Nenhuma sessão viva NESTE projeto, mas a conta já está cheia.
      vivasNaConta: 15,
      delegadasHoje: 0,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
    })
    expect(escolhidas).toEqual([])
  })

  it('com a conta com folga, delega normalmente', () => {
    const escolhidas = escolherParaDelegar({
      candidatas: [candidata(1), candidata(2)],
      sessoesVivas: [],
      vivasNaConta: 13,
      delegadasHoje: 0,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
    })
    expect(escolhidas).toEqual([1, 2])
  })

  // Sem o número da conta, o comportamento é o antigo — o que mantém os
  // chamadores que ainda não passam a informação funcionando como antes.
  it('sem o número da conta, cai nas vivas deste projeto', () => {
    const escolhidas = escolherParaDelegar({
      candidatas: [candidata(1)],
      sessoesVivas: [],
      delegadasHoje: 0,
      tetoConcorrentes: 1,
      tetoDiario: 100,
      capPorCiclo: 3,
    })
    expect(escolhidas).toEqual([1])
  })
})
