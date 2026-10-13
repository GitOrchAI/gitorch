// Costura real do revisor com a verificação do GitHub: a única coisa de
// mentira aqui é o GitHub (a borda de rede). O revisor, a leitura do CI, o
// pedido de nova execução e a decisão de esperar/julgar são os de verdade.
//
// O que se prova: execução cancelada ou ausente NÃO é reprovação; o sistema
// pede UMA nova execução por commit; só job que falhou de verdade reprova (e
// o parecer cita o job); o parecer vale só para o commit julgado.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { runQaMissionViaRails } from './qa-rails-mission.js'
import { MARCA_DO_PARECER } from './parecer-do-qa.js'
import { cacheDoProcesso } from './cache-de-verificacao-pendente.js'
import { cacheDePermissaoDoProcesso } from './permissao-de-admin.js'
import { esquecerPedidosDeNovaExecucao } from './nova-execucao-do-ci.js'

beforeEach(() => {
  cacheDoProcesso.limpar()
  cacheDePermissaoDoProcesso.limpar()
  esquecerPedidosDeNovaExecucao()
})

const VEREDITO = JSON.stringify({
  verdict: 'request_changes',
  comment: {
    titulo: 'Faltou validação',
    goal: 'Rework necessário.',
    taskDetails: 'Sem checagem de material no controller.',
    taskDescription: 'POST /reviews não valida material.',
    implementationGuide: '1. validar body; 2. teste do caso inválido',
    verificationCriteria: '- retornar 400 para material inexistente',
    dependencies: 'nenhuma',
    relatedFiles: 'src/reviews.ts',
    notes: 'Ajuste necessário.',
  },
  entendimento: {
    deOndeVeio: 'Jules reportou bug',
    oQueMuda: 'Validação no controller',
    queAjusteE: 'correção importante',
    porQueExiste: 'Evitar erro 500 sem validação de material',
  },
})

interface Check {
  id?: number
  name?: string
  status?: string
  conclusion?: string
}
interface Run {
  id: number
  status: string
  conclusion: string | null
  run_attempt: number
}

/** O GitHub de mentira: tudo mutável, para o teste mudar o mundo entre passadas. */
function githubFalso(inicial: {
  sha?: string
  checks?: Check[]
  runs?: Run[]
  workflows?: Array<{ path: string; state: string }>
  mergeableState?: string
  reviews?: Array<{ body: string; commit_id: string }>
  rerunStatus?: number
}) {
  const mundo = {
    sha: inicial.sha ?? 'sha-1',
    checks: inicial.checks ?? [],
    runs: inicial.runs ?? [],
    workflows: inicial.workflows ?? [],
    mergeableState: inicial.mergeableState ?? 'clean',
    reviews: inicial.reviews ?? [],
    rerunStatus: inicial.rerunStatus ?? 200,
  }
  const reruns: string[] = []
  const reviewsPostadas: Array<{ event?: string; body?: string }> = []
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status })
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const metodo = init?.method ?? 'GET'
    const corpo = init?.body ? JSON.parse(String(init.body)) : {}
    const caminho = u.split('?')[0]!
    if (u.includes('/pulls?')) {
      return json([
        {
          number: 7,
          user: { login: 'jules[bot]' },
          draft: false,
          body: 'Closes #50',
          head: { sha: mundo.sha, ref: 'feat/entrega' },
        },
      ])
    }
    if (/\/pulls\/7\/reviews$/.test(caminho)) {
      if (metodo === 'POST') {
        reviewsPostadas.push(corpo)
        return json({ id: 1 })
      }
      return json(mundo.reviews)
    }
    if (/\/pulls\/7$/.test(caminho)) {
      return json({
        number: 7,
        body: 'Closes #50',
        mergeable_state: mundo.mergeableState,
        head: { sha: mundo.sha, ref: 'feat/entrega' },
        base: { ref: 'main' },
      })
    }
    if (/\/pulls\/7\/files$/.test(caminho)) {
      const pagina = Number(new URL(u).searchParams.get('page') ?? '1')
      return json(pagina > 1 ? [] : [{ filename: 'src/a.ts', patch: '+x' }])
    }
    if (u.includes('/issues/50') && !u.includes('/comments')) {
      return json({
        number: 50,
        labels: [{ name: 'jules' }, { name: 'gitorch:task' }],
        body: '## Verification Criteria\n\n- critério',
      })
    }
    if (/\/commits\/[^/]+\/check-runs$/.test(caminho)) return json({ check_runs: mundo.checks })
    if (caminho.endsWith('/actions/runs')) return json({ workflow_runs: mundo.runs })
    if (caminho.endsWith('/actions/workflows')) return json({ workflows: mundo.workflows })
    const rerun = caminho.match(/\/actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs)$/)
    if (rerun && metodo === 'POST') {
      reruns.push(`${rerun[1]}/${rerun[2]}`)
      return mundo.rerunStatus === 200
        ? json({})
        : json({ message: 'Resource not accessible by integration' }, mundo.rerunStatus)
    }
    if (/\/actions\/jobs\/\d+$/.test(caminho)) return json({ steps: [] })
    if (/\/issues\/\d+\/comments$/.test(caminho)) return json(metodo === 'GET' ? [] : { id: 1 })
    if (caminho.endsWith('/user')) return json({ login: 'dono-do-repo' })
    return json({})
  }) as typeof fetch
  return { impl, mundo, reruns, reviewsPostadas }
}

async function passada(gh: ReturnType<typeof githubFalso>, execute = vi.fn(async () => VEREDITO)) {
  const resultado = await runQaMissionViaRails({
    prisma: {
      repoItem: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaClient,
    projectId: 'proj',
    repository: 'acme/api',
    githubToken: 't',
    execute,
    fetchImpl: gh.impl,
  })
  return { resultado, execute }
}

const cancelado = (id: number, name: string): Check => ({
  id,
  name,
  status: 'completed',
  conclusion: 'cancelled',
})
const sucesso = (id: number, name: string): Check => ({
  id,
  name,
  status: 'completed',
  conclusion: 'success',
})
const execucaoCancelada: Run = {
  id: 900,
  status: 'completed',
  conclusion: 'cancelled',
  run_attempt: 1,
}

describe('revisor x verificação cancelada', () => {
  it('execução cancelada: não pede mudanças, registra "sem resultado" e pede UMA nova execução', async () => {
    const gh = githubFalso({
      checks: [cancelado(1, 'Testes'), cancelado(2, 'Lint')],
      runs: [execucaoCancelada],
    })
    const { resultado, execute } = await passada(gh)
    expect(execute).not.toHaveBeenCalled()
    expect(gh.reviewsPostadas).toHaveLength(0)
    expect(resultado.noOp).toBe(true)
    expect(resultado.output).toMatch(/sem resultado de verificação/)
    expect(gh.reruns).toEqual(['900/rerun'])
  })

  it('segunda passada no mesmo commit: não repete o pedido de nova execução', async () => {
    const gh = githubFalso({
      checks: [cancelado(1, 'Testes')],
      runs: [execucaoCancelada],
    })
    await passada(gh)
    const { resultado } = await passada(gh)
    expect(gh.reruns).toHaveLength(1)
    expect(resultado.noOp).toBe(true)
    expect(gh.reviewsPostadas).toHaveLength(0)
  })

  it('o teto também vale depois de o serviço reiniciar: execução já na 2ª tentativa não é repetida', async () => {
    const gh = githubFalso({
      checks: [cancelado(1, 'Testes')],
      runs: [{ ...execucaoCancelada, run_attempt: 2 }],
    })
    await passada(gh)
    expect(gh.reruns).toHaveLength(0)
  })

  it('resultado real depois da nova execução: o revisor julga', async () => {
    const gh = githubFalso({ checks: [cancelado(1, 'Testes')], runs: [execucaoCancelada] })
    await passada(gh)
    gh.mundo.checks = [sucesso(1, 'Testes')]
    gh.mundo.runs = [{ id: 900, status: 'completed', conclusion: 'success', run_attempt: 2 }]
    cacheDoProcesso.limpar()
    const { execute, resultado } = await passada(gh)
    expect(execute).toHaveBeenCalled()
    expect(gh.reviewsPostadas).toHaveLength(1)
    expect(resultado.output).toContain('CI green')
  })

  it('sem permissão para pedir a execução: não reprova, não insiste e diz o motivo em palavras simples', async () => {
    const gh = githubFalso({
      checks: [cancelado(1, 'Testes')],
      runs: [execucaoCancelada],
      rerunStatus: 403,
    })
    const a = await passada(gh)
    const b = await passada(gh)
    expect(gh.reruns).toHaveLength(1)
    expect(gh.reviewsPostadas).toHaveLength(0)
    expect(a.resultado.output).toMatch(/permiss/)
    expect(b.resultado.noOp).toBe(true)
  })
})

describe('revisor x verificação que não aconteceu', () => {
  const fluxo = [{ path: '.github/workflows/ci.yml', state: 'active' }]

  it('repositório COM workflow e zero execuções no commit: "sem resultado", nunca "sem verificações"', async () => {
    const gh = githubFalso({ checks: [], runs: [], workflows: fluxo })
    const { resultado, execute } = await passada(gh)
    expect(execute).not.toHaveBeenCalled()
    expect(resultado.noOp).toBe(true)
    expect(resultado.output).toMatch(/sem resultado de verificação/)
    expect(resultado.output).toMatch(/nenhuma execução/)
    expect(resultado.output).not.toMatch(/no automated checks/)
    expect(gh.reruns).toHaveLength(0)
    expect(gh.reviewsPostadas).toHaveLength(0)
  })

  it('PR com conflito: a saída diz que o conflito impede o GitHub de rodar a verificação', async () => {
    const gh = githubFalso({ checks: [], runs: [], workflows: fluxo, mergeableState: 'dirty' })
    const { resultado } = await passada(gh)
    expect(resultado.output).toMatch(/conflito/)
  })

  it('repositório SEM workflow nenhum: continua "sem verificações" e vira lacuna registrada', async () => {
    const gh = githubFalso({ checks: [], runs: [], workflows: [] })
    const { resultado, execute } = await passada(gh)
    expect(execute).toHaveBeenCalled()
    expect(resultado.output).toContain('GITORCH-GAP: this repository has no automated checks')
  })
})

describe('revisor x job que falhou de verdade', () => {
  it('job falho entre cancelados: pede mudanças e o parecer cita o NOME do job', async () => {
    const gh = githubFalso({
      checks: [
        { id: 1, name: 'Testes Backend', status: 'completed', conclusion: 'failure' },
        cancelado(2, 'Lint'),
        cancelado(3, 'Build'),
      ],
      runs: [execucaoCancelada],
    })
    const { resultado } = await passada(gh)
    expect(gh.reviewsPostadas).toHaveLength(1)
    expect(gh.reviewsPostadas[0]!.event).toBe('REQUEST_CHANGES')
    expect(gh.reviewsPostadas[0]!.body).toContain('Testes Backend')
    expect(resultado.output).toContain('CI red')
    expect(gh.reruns).toHaveLength(0)
  })
})

describe('o parecer vale só para o commit julgado', () => {
  const parecerAntigo = {
    body: `${MARCA_DO_PARECER}\nGitOrch QA verdict: REQUEST CHANGES (see comment).`,
    commit_id: 'sha-antigo',
  }

  it('commit novo: o parecer do commit antigo não segura o PR, ele é julgado de novo', async () => {
    const gh = githubFalso({
      sha: 'sha-novo',
      checks: [sucesso(1, 'Testes')],
      reviews: [parecerAntigo],
    })
    const { execute } = await passada(gh)
    expect(execute).toHaveBeenCalled()
    expect(gh.reviewsPostadas).toHaveLength(1)
  })

  it('mesmo commit: um parecer só, não dois', async () => {
    const gh = githubFalso({
      sha: 'sha-antigo',
      checks: [sucesso(1, 'Testes')],
      reviews: [parecerAntigo],
    })
    const { execute } = await passada(gh)
    expect(execute).not.toHaveBeenCalled()
    expect(gh.reviewsPostadas).toHaveLength(0)
  })
})
