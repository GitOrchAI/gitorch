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

  it('sessão COMPLETED/FAILED não consome vaga de concorrência (a vaga já liberou no Jules)', () => {
    // O defeito de 29/08: 15 linhas COMPLETED abertas na conta = teto batido,
    // folga negativa, zero delegação. O fallback filtra por ocupaVaga.
    const quinzeCompletas = Array.from({ length: 15 }, (_, i) =>
      linha({ issueNumber: 100 + i, state: 'COMPLETED' })
    )
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10 }), issue({ number: 11 })],
        sessoesVivas: quinzeCompletas,
        tetoConcorrentes: 15,
      })
    ).toEqual([10, 11])
  })

  it('usa ocupamVagaNaConta quando vem pré-calculado (o número da conta inteira, não deste projeto)', () => {
    expect(
      escolherParaDelegar({
        ...base,
        candidatas: [issue({ number: 10 }), issue({ number: 11 })],
        sessoesVivas: [], // este projeto está vazio…
        ocupamVagaNaConta: 15, // …mas a conta já está no teto por outro projeto
        tetoConcorrentes: 15,
      })
    ).toEqual([])
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
  // ESTEIRA-T11: o diagnóstico de "voltou vazia por VAGA".
  it('conta lotada + fila pronta + folga diária → travadaPorVaga: true', () => {
    let d: { travadaPorVaga: boolean } | undefined
    escolherParaDelegar({
      candidatas: [candidata(1), candidata(2)],
      sessoesVivas: [],
      ocupamVagaNaConta: 15,
      delegadasHoje: 3,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
      onDiagnostico: (x) => {
        d = x
      },
    })
    expect(d?.travadaPorVaga).toBe(true)
  })

  it('candidatas existem mas TODAS bloqueadas por dependência → travadaPorVaga: false', () => {
    // O falso alarme que o T11 não pode dar: backlog com "Blocked by #N"
    // aberto é a norma (o sprint cria a árvore inteira de uma vez). Nada está
    // pronto — a conta cheia não é o obstáculo, e avisar o dono para "subir o
    // teto ou encerrar uma sessão" não destravaria nada.
    let d: { travadaPorVaga: boolean } | undefined
    escolherParaDelegar({
      candidatas: [
        { number: 1, bloqueadoresAbertos: 2 },
        { number: 2, bloqueadoresAbertos: 1 },
      ],
      sessoesVivas: [],
      ocupamVagaNaConta: 15,
      delegadasHoje: 3,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
      onDiagnostico: (x) => {
        d = x
      },
    })
    expect(d?.travadaPorVaga).toBe(false)
  })

  it('candidatas todas presas na análise das 2 falhas → travadaPorVaga: false', () => {
    let d: { travadaPorVaga: boolean } | undefined
    escolherParaDelegar({
      candidatas: [candidata(1), candidata(2)],
      sessoesVivas: [],
      issuesComAnalisePendente: [1, 2],
      ocupamVagaNaConta: 15,
      delegadasHoje: 3,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
      onDiagnostico: (x) => {
        d = x
      },
    })
    expect(d?.travadaPorVaga).toBe(false)
  })

  it('uma pronta no meio de bloqueadas + conta cheia → travadaPorVaga: true', () => {
    let d: { travadaPorVaga: boolean } | undefined
    escolherParaDelegar({
      candidatas: [
        { number: 1, bloqueadoresAbertos: 2 },
        { number: 2, bloqueadoresAbertos: 0 },
      ],
      sessoesVivas: [],
      ocupamVagaNaConta: 15,
      delegadasHoje: 3,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
      onDiagnostico: (x) => {
        d = x
      },
    })
    expect(d?.travadaPorVaga).toBe(true)
  })

  it('fila vazia → travadaPorVaga: false (não é notícia)', () => {
    let d: { travadaPorVaga: boolean } | undefined
    escolherParaDelegar({
      candidatas: [],
      sessoesVivas: [],
      ocupamVagaNaConta: 15,
      delegadasHoje: 3,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
      onDiagnostico: (x) => {
        d = x
      },
    })
    expect(d?.travadaPorVaga).toBe(false)
  })

  it('teto DIÁRIO batido (não vaga) → travadaPorVaga: false', () => {
    let d: { travadaPorVaga: boolean } | undefined
    escolherParaDelegar({
      candidatas: [candidata(1)],
      sessoesVivas: [],
      ocupamVagaNaConta: 2,
      delegadasHoje: 100,
      tetoConcorrentes: 15,
      tetoDiario: 100,
      capPorCiclo: 3,
      onDiagnostico: (x) => {
        d = x
      },
    })
    expect(d?.travadaPorVaga).toBe(false)
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

// ── L4-T5: issue com PR aberto do dev não volta para a fila ────────────────
//
// Medido: issue #3884 do Jardim, 5 sessões e 3 PRs (#3907, #3913, #3917) para
// UMA task. A sessão morre (`pr-rejeitado-sem-retomada`), a issue solta a
// sessão viva, e nada mais impedia `escolherParaDelegar` de tratá-la como
// livre — mesmo com o PR anterior ainda aberto esperando conserto. A
// retomada certa é no MESMO PR (retomar-pr-reprovado.ts); a fila só pode
// voltar a tratar a issue como livre depois que aquele PR fechar.
describe('escolherParaDelegar: issue com PR aberto do dev não volta para a fila', () => {
  const semTeto = {
    sessoesVivas: [],
    delegadasHoje: 0,
    tetoConcorrentes: 10,
    tetoDiario: 10,
    capPorCiclo: 10,
  }

  it('NÃO escolhe issue cuja sessão morreu mas o PR do dev continua aberto', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [issue({ number: 3884 })],
      issuesComPrAbertoDoDev: new Set([3884]),
    })
    expect(escolhidas).toEqual([])
  })

  it('volta a escolher assim que o PR sai do conjunto (fechou/mesclou)', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [issue({ number: 3884 })],
      issuesComPrAbertoDoDev: new Set(),
    })
    expect(escolhidas).toEqual([3884])
  })

  it('o campo é OPCIONAL — chamador antigo não muda de comportamento', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [issue({ number: 10 })],
    })
    expect(escolhidas).toEqual([10])
  })

  it('issue com PR aberto do dev não consome vaga do teto por ciclo', () => {
    // Mesma disciplina do bloqueio por arquivo: barrada não pode gastar a
    // cota de quem vem depois dela na mesma passada.
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      capPorCiclo: 1,
      candidatas: [issue({ number: 1 }), issue({ number: 2 })],
      issuesComPrAbertoDoDev: new Set([1]),
    })
    expect(escolhidas).toEqual([2])
  })

  it('outras issues sem PR aberto continuam entrando normalmente', () => {
    const escolhidas = escolherParaDelegar({
      ...semTeto,
      candidatas: [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })],
      issuesComPrAbertoDoDev: new Set([2]),
    })
    expect(escolhidas).toEqual([1, 3])
  })
})
