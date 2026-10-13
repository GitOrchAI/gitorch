import { describe, it, expect } from 'vitest'
import {
  estadoDoCi,
  investigarEstadoDoCi,
  lerEstadoDoCiDoHead,
  nomesDosJobsComFalha,
} from './estado-da-verificacao-do-github.js'
import type { PassoDoJob } from './causa-do-cancelamento.js'

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
  // seria aprovar sobre um teste que não terminou. "cancelled" SAIU desta
  // lista (L4-T17, ver describe próprio abaixo) — sozinho ele vira o estado
  // "sem-resultado", não "red".
  it.each(['timed_out', 'startup_failure'])(
    'conclusão "%s" é falha real: vermelho',
    (conclusao) => {
      expect(estadoDoCi([ok(), { status: 'completed', conclusion: conclusao }])).toBe('red')
    }
  )

  // Estas conclusões não provam falha de ninguém: a execução foi obsoleta
  // (`stale`), espera uma pessoa liberar (`action_required`) ou o GitHub
  // inventou um valor novo. O produto não reprova por elas e também não
  // inventa que passou: não há resultado.
  it.each(['action_required', 'stale', 'algo_novo_do_github'])(
    'conclusão "%s" não é falha nem sucesso: sem resultado',
    (conclusao) => {
      expect(estadoDoCi([ok(), { status: 'completed', conclusion: conclusao }])).toBe(
        'sem-resultado'
      )
    }
  )

  it('conclusão ausente num check terminado: sem resultado', () => {
    expect(estadoDoCi([ok(), { status: 'completed' }])).toBe('sem-resultado')
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

  // L4-T17 — medido em loureng/patinhas-3d-crafts: 5 PRs abertos, vários
  // checks cancelados, NENHUM parecer do QA — paravam em silêncio porque
  // "cancelled" caía no mesmo balaio de "failure" (reprova). A causa real,
  // provada no run 33943490885 (PR #3945): um job de qualidade cujo próprio
  // passo de Prettier falhava cancelava o run inteiro em cadeia. Precisa
  // distinguir cancelamento COM culpa (existe falha real por trás) de
  // cancelamento SEM culpa (push novo, concorrência — nada falhou de
  // verdade).
  describe('cancelamento — com culpa vs. sem culpa', () => {
    it('só cancelado, nenhuma falha real ao lado: "sem-resultado" — não é reprovação, é indefinido', () => {
      expect(estadoDoCi([ok(), { status: 'completed', conclusion: 'cancelled' }])).toBe(
        'sem-resultado'
      )
    })

    it('todos cancelados (nem um sucesso): "sem-resultado", nunca "green"', () => {
      expect(
        estadoDoCi([
          { status: 'completed', conclusion: 'cancelled' },
          { status: 'completed', conclusion: 'cancelled' },
        ])
      ).toBe('sem-resultado')
    })

    // O caso medido ao vivo: o job de Qualidade aparece "cancelled" no
    // nível do JOB (o cancelamento em cadeia alcança até ele), mas o
    // job-gate ("CI passou — pronto para merge") aparece "failure" de
    // verdade — a falha real existe, só que em outro job. `estadoDoCi`
    // decide pelo CONJUNTO de conclusões de job; achar QUAL job/passo é a
    // causa legível é trabalho de `causa-do-cancelamento.ts`, mais fundo.
    it('cancelado JUNTO com uma falha real em outro job: continua "red" — a falha real manda', () => {
      expect(
        estadoDoCi([
          ok(),
          { status: 'completed', conclusion: 'cancelled' },
          { status: 'completed', conclusion: 'failure' },
        ])
      ).toBe('red')
    })
  })
})

// Verde exige PROVA: pelo menos um job que rodou e passou. Logo depois de um
// push, o único check-run já registrado pode ser um job condicional que
// termina `skipped` na hora, enquanto os jobs reais ainda nem existem como
// check-run (fila do runner). Aceitar isso como verde mesclou código sem CI.
describe('estadoDoCi — verde só com pelo menos um sucesso real', () => {
  it('só [skipped]: NÃO é verde — é "sem-resultado" (jobs reais ainda podem chegar)', () => {
    expect(estadoDoCi([{ status: 'completed', conclusion: 'skipped' }])).toBe('sem-resultado')
  })

  it('só skipped/neutral, vários: continua "sem-resultado", nunca "green"', () => {
    expect(
      estadoDoCi([
        { status: 'completed', conclusion: 'skipped' },
        { status: 'completed', conclusion: 'neutral' },
        { status: 'completed', conclusion: 'skipped' },
      ])
    ).toBe('sem-resultado')
  })

  it('[skipped, success]: verde', () => {
    expect(estadoDoCi([{ status: 'completed', conclusion: 'skipped' }, ok()])).toBe('green')
  })

  // Regressão que não pode voltar: repositório com jobs condicionais pulados
  // em toda entrega normal e os jobs reais passando.
  it('[success, success, skipped]: verde', () => {
    expect(estadoDoCi([ok(), ok(), { status: 'completed', conclusion: 'skipped' }])).toBe('green')
  })
})

// A tabela inteira: o que cada combinação de conclusões de job vira. Só falha
// de verdade (`failure`, `timed_out`, `startup_failure`) reprova; o resto que
// não passou é "sem resultado".
describe('estadoDoCi — tabela de conclusões', () => {
  const j = (conclusion: string, name = 'job') => ({ status: 'completed', conclusion, name })
  it.each([
    ['1 cancelado + 1 sucesso', [j('cancelled'), j('success')], 'sem-resultado'],
    ['todos pulados', [j('skipped'), j('skipped'), j('skipped')], 'sem-resultado'],
    ['1 falho + 5 cancelados', [j('failure', 'Testes'), ...Array(5).fill(j('cancelled'))], 'red'],
    ['timed_out + sucesso', [j('timed_out'), j('success')], 'red'],
    ['stale + sucesso', [j('stale'), j('success')], 'sem-resultado'],
    ['action_required + sucesso', [j('action_required'), j('success')], 'sem-resultado'],
    ['sucesso + pulado + neutro', [j('success'), j('skipped'), j('neutral')], 'green'],
    ['falho + em andamento', [j('failure'), { status: 'in_progress' }], 'pending'],
  ] as const)('%s', (_nome, jobs, esperado) => {
    expect(estadoDoCi([...jobs])).toBe(esperado)
  })

  it('o nome do job que falhou acompanha o estado: 1 falho + 5 cancelados cita o falho', () => {
    const jobs = [
      { status: 'completed', conclusion: 'failure', name: 'Testes Backend' },
      ...Array.from({ length: 5 }, (_, i) => ({
        status: 'completed',
        conclusion: 'cancelled',
        name: `Outro ${i}`,
      })),
    ]
    expect(nomesDosJobsComFalha(jobs)).toEqual(['Testes Backend'])
  })
})

/** Um GitHub de mentira só com as duas leituras que o estado do CI precisa. */
function githubDoHead(opcoes: {
  checkRuns: Array<{ id?: number; name?: string; status?: string; conclusion?: string }>
  workflowRuns?:
    | Array<{ id?: number; status?: string; conclusion?: string | null; run_attempt?: number }>
    | 'falha'
  /** Workflows registrados no repositório. Default: nenhum. 'falha' = a leitura quebra. */
  workflows?: Array<{ path: string; state: string }> | 'falha'
}) {
  const caminhos: string[] = []
  const ghGet = async (caminho: string): Promise<unknown> => {
    caminhos.push(caminho)
    if (caminho.includes('/check-runs')) return { check_runs: opcoes.checkRuns }
    if (caminho.includes('/actions/runs?')) {
      if (opcoes.workflowRuns === 'falha') throw new Error('GitHub 502')
      return { workflow_runs: opcoes.workflowRuns ?? [] }
    }
    if (caminho.includes('/actions/workflows')) {
      if (opcoes.workflows === 'falha') throw new Error('GitHub 502')
      return { workflows: opcoes.workflows ?? [] }
    }
    throw new Error(`caminho inesperado: ${caminho}`)
  }
  return { ghGet, caminhos }
}

// Fecha a janela "check-runs ainda não registrados": o workflow run do mesmo
// commit existe (na fila) antes de os jobs dele virarem check-run.
describe('lerEstadoDoCiDoHead — check-runs + workflow runs do mesmo commit', () => {
  const ler = (gh: ReturnType<typeof githubDoHead>) =>
    lerEstadoDoCiDoHead({ repositorio: 'o/r', sha: 'abc', ghGet: gh.ghGet })

  it('check-runs todos success, mas um workflow run in_progress: "pending"', async () => {
    const gh = githubDoHead({
      checkRuns: [ok(), ok()],
      workflowRuns: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }],
    })
    expect((await ler(gh)).estado).toBe('pending')
  })

  it.each(['queued', 'waiting', 'pending', 'requested'])(
    'workflow run "%s" com check-runs verdes: "pending"',
    async (status) => {
      const gh = githubDoHead({ checkRuns: [ok()], workflowRuns: [{ status }] })
      expect((await ler(gh)).estado).toBe('pending')
    }
  )

  it('check-runs verdes e todos os workflow runs terminados: "green"', async () => {
    const gh = githubDoHead({
      checkRuns: [ok(), { status: 'completed', conclusion: 'skipped' }],
      workflowRuns: [{ status: 'completed', conclusion: 'success' }],
    })
    expect((await ler(gh)).estado).toBe('green')
  })

  it('falha ao ler os workflow runs: nunca "green" — vira "pending"', async () => {
    const gh = githubDoHead({ checkRuns: [ok()], workflowRuns: 'falha' })
    expect((await ler(gh)).estado).toBe('pending')
  })

  it('sem check-run nenhum, mas workflow run na fila: "pending", não "no checks"', async () => {
    const gh = githubDoHead({ checkRuns: [], workflowRuns: [{ status: 'queued' }] })
    expect((await ler(gh)).estado).toBe('pending')
  })

  it('sem check-run e sem workflow run: "no checks" continua estável', async () => {
    const gh = githubDoHead({ checkRuns: [], workflowRuns: [] })
    expect((await ler(gh)).estado).toBe('no checks')
  })

  it('o caso dos jobs reais ainda não registrados: só [skipped] + workflow na fila → "pending"', async () => {
    const gh = githubDoHead({
      checkRuns: [{ status: 'completed', conclusion: 'skipped' }],
      workflowRuns: [{ status: 'completed', conclusion: 'skipped' }, { status: 'queued' }],
    })
    expect((await ler(gh)).estado).toBe('pending')
  })

  // O repositório TEM verificação (arquivo de workflow ativo), mas este commit
  // não gerou execução nenhuma — o caso do PR com conflito de merge, em que o
  // GitHub não dispara o CI. Dizer "o repositório não tem verificações" seria
  // falso; reprovar também.
  it('workflow registrado, zero check-runs e zero execuções: "sem-resultado", não "no checks"', async () => {
    const gh = githubDoHead({
      checkRuns: [],
      workflowRuns: [],
      workflows: [{ path: '.github/workflows/ci.yml', state: 'active' }],
    })
    const leitura = await ler(gh)
    expect(leitura.estado).toBe('sem-resultado')
    expect(leitura.execucoes).toEqual([])
  })

  it('o workflow dinâmico do Dependabot não conta como verificação do repositório', async () => {
    const gh = githubDoHead({
      checkRuns: [],
      workflowRuns: [],
      workflows: [{ path: 'dynamic/dependabot/dependabot-updates', state: 'active' }],
    })
    expect((await ler(gh)).estado).toBe('no checks')
  })

  it('workflow desativado não conta como verificação: "no checks"', async () => {
    const gh = githubDoHead({
      checkRuns: [],
      workflowRuns: [],
      workflows: [{ path: '.github/workflows/velho.yml', state: 'disabled_manually' }],
    })
    expect((await ler(gh)).estado).toBe('no checks')
  })

  it('não dá para ler os workflows do repositório: não prova ausência, vira "sem-resultado"', async () => {
    const gh = githubDoHead({ checkRuns: [], workflowRuns: [], workflows: 'falha' })
    expect((await ler(gh)).estado).toBe('sem-resultado')
  })

  it('execução do commit terminou sem criar job nenhum e falhou (workflow inválido): "red"', async () => {
    const gh = githubDoHead({
      checkRuns: [],
      workflowRuns: [{ id: 7, status: 'completed', conclusion: 'startup_failure' }],
    })
    expect((await ler(gh)).estado).toBe('red')
  })

  it('check-runs só cancelados e execução cancelada: "sem-resultado" com a execução para reexecutar', async () => {
    const gh = githubDoHead({
      checkRuns: [
        { id: 1, name: 'Testes', status: 'completed', conclusion: 'cancelled' },
        { id: 2, name: 'Lint', status: 'completed', conclusion: 'cancelled' },
      ],
      workflowRuns: [{ id: 99, status: 'completed', conclusion: 'cancelled', run_attempt: 1 }],
    })
    const leitura = await ler(gh)
    expect(leitura.estado).toBe('sem-resultado')
    expect(leitura.execucoes).toEqual([
      { id: 99, status: 'completed', conclusion: 'cancelled', tentativa: 1 },
    ])
  })

  it('cancelado e execução ainda na fila (nova tentativa): "pending"', async () => {
    const gh = githubDoHead({
      checkRuns: [{ id: 1, name: 'Testes', status: 'completed', conclusion: 'cancelled' }],
      workflowRuns: [{ id: 99, status: 'queued', run_attempt: 2 }],
    })
    expect((await ler(gh)).estado).toBe('pending')
  })

  it('vermelho traz o nome do job que falhou, e só dele', async () => {
    const gh = githubDoHead({
      checkRuns: [
        { id: 1, name: 'Testes Backend', status: 'completed', conclusion: 'failure' },
        { id: 2, name: 'Lint', status: 'completed', conclusion: 'cancelled' },
        { id: 3, name: 'Build', status: 'completed', conclusion: 'success' },
      ],
    })
    const leitura = await ler(gh)
    expect(leitura.estado).toBe('red')
    expect(leitura.jobsComFalha).toEqual(['Testes Backend'])
  })

  it('consulta os workflow runs DAQUELE commit, com página cheia', async () => {
    const gh = githubDoHead({ checkRuns: [ok()], workflowRuns: [] })
    await ler(gh)
    expect(gh.caminhos).toContain('/repos/o/r/actions/runs?head_sha=abc&per_page=100')
  })

  // Vermelho já é veredito: um workflow ainda rodando não o torna verde, e a
  // chamada a mais seria cota gasta à toa.
  it('vermelho não gasta a leitura de workflow runs', async () => {
    const gh = githubDoHead({
      checkRuns: [{ status: 'completed', conclusion: 'failure' }],
      workflowRuns: [{ status: 'in_progress' }],
    })
    expect((await ler(gh)).estado).toBe('red')
    expect(gh.caminhos.some((c) => c.includes('/actions/runs?'))).toBe(false)
  })
})

// L4-T17 fix-up (achado 1 da revisão) — REGRESSÃO: a saída 'cancelado' era
// decidida só pela conclusão de cada job, sem nunca olhar os passos. Se o
// workflow do cliente não tem um job separado que termine `failure`, o
// estado virava 'cancelado' para sempre, o QA nunca investigava, e a
// vigília só sabia esperar — nunca chegava a julgar (antes de L4-T17,
// cancelado virava vermelho direto; ao menos era julgado). `estadoDoCi`
// continua PURO (não pode investigar — não tem rede); quem investiga é
// `investigarEstadoDoCi`, que envolve a decisão pura e só busca os passos
// quando a resposta pura seria inconclusiva.
describe('investigarEstadoDoCi', () => {
  it('achado 1: cancelado com falha real escondida num passo — investiga, promove a "red" e traz o culpado', async () => {
    const runs = [
      { id: 1, name: 'Qualidade', status: 'completed', conclusion: 'cancelled' },
      { id: 2, name: 'outro', status: 'completed', conclusion: 'cancelled' },
    ]
    const passosPorJob: Record<number, PassoDoJob[]> = {
      1: [{ name: 'Prettier', conclusion: 'failure', completedAt: '2026-09-05T04:40:14Z' }],
      2: [{ name: 'Rodar', conclusion: 'cancelled', completedAt: '2026-09-05T04:40:15Z' }],
    }
    const resultado = await investigarEstadoDoCi(runs, async (id) => passosPorJob[id] ?? [])
    expect(resultado.estado).toBe('red')
    expect(resultado.culpado).toEqual({
      encontrado: true,
      ambiguo: false,
      job: 'Qualidade',
      passo: 'Prettier',
    })
  })

  it('achado 1: cancelado sem falha real em passo nenhum — investiga e CONTINUA sem resultado (indefinido), não vira veredito', async () => {
    const runs = [{ id: 1, name: 'job', status: 'completed', conclusion: 'cancelled' }]
    const resultado = await investigarEstadoDoCi(runs, async () => [
      { name: 'Rodar', conclusion: 'cancelled', completedAt: '2026-09-05T04:40:15Z' },
    ])
    expect(resultado.estado).toBe('sem-resultado')
    expect(resultado.culpado).toEqual({ encontrado: false })
  })

  // green / pending / no checks / red-sem-cancelado-no-meio: nunca precisam
  // investigar — gastar uma chamada de rede aqui seria à toa.
  it('não investiga quando a resposta pura já é conclusiva (não gasta chamada de rede à toa)', async () => {
    let chamou = false
    const buscar = async (): Promise<PassoDoJob[]> => {
      chamou = true
      return []
    }
    expect((await investigarEstadoDoCi([], buscar)).estado).toBe('no checks')
    expect(
      (await investigarEstadoDoCi([{ status: 'completed', conclusion: 'success' }], buscar)).estado
    ).toBe('green')
    expect((await investigarEstadoDoCi([{ status: 'in_progress' }], buscar)).estado).toBe('pending')
    // 'red' sem NENHUM 'cancelled' misturado: já é conclusivo por si, nada
    // escondido para investigar.
    expect(
      (await investigarEstadoDoCi([{ status: 'completed', conclusion: 'failure' }], buscar)).estado
    ).toBe('red')
    expect(chamou).toBe(false)
  })

  // 'red' com cancelamento misturado a uma falha real (caso original,
  // pré-L4-T17): continua investigando, mas só para enriquecer a
  // explicação — o estado já era 'red' e continua 'red'.
  it('red com cancelamento misturado: investiga para achar a causa legível, mas o estado já era red e continua red', async () => {
    const runs = [
      { id: 1, name: 'Qualidade', status: 'completed', conclusion: 'cancelled' },
      { id: 2, name: 'gate', status: 'completed', conclusion: 'failure' },
    ]
    const passosPorJob: Record<number, PassoDoJob[]> = {
      1: [{ name: 'Prettier', conclusion: 'failure', completedAt: '2026-09-05T04:40:14Z' }],
      2: [{ name: 'Verificar', conclusion: 'failure', completedAt: '2026-09-05T04:40:21Z' }],
    }
    const resultado = await investigarEstadoDoCi(runs, async (id) => passosPorJob[id] ?? [])
    expect(resultado.estado).toBe('red')
    expect(resultado.culpado).toEqual({
      encontrado: true,
      ambiguo: false,
      job: 'Qualidade',
      passo: 'Prettier',
    })
  })
})
