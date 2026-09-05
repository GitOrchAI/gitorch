import { describe, it, expect } from 'vitest'
import {
  acharCulpadoDoCancelamento,
  frasarCausaDoCancelamento,
  investigarCancelamentoEmCadeia,
  type JobComPassos,
  type JobDoGithub,
  type PassoDoJob,
} from './causa-do-cancelamento.js'

// Fixture fiel ao medido AO VIVO: run 33943490885, PR #3945 em
// loureng/patinhas-3d-crafts (gh run view / gh api, 05/09/2026). O job de
// qualidade falha no passo de Prettier, dispara o próprio passo de
// "cancelar o workflow", e por isso TERMINA marcado `cancelled` no nível do
// job — só a API de jobs (steps) mostra que o passo de dentro falhou.
const QUALIDADE: JobComPassos = {
  name: '✅ Qualidade — Lint + Typecheck + Prettier',
  conclusion: 'cancelled',
  steps: [
    { name: 'Set up job', conclusion: 'success', completedAt: '2026-09-05T04:37:12Z' },
    {
      name: 'Setup pnpm + cache + install',
      conclusion: 'success',
      completedAt: '2026-09-05T04:38:00Z',
    },
    {
      name: 'Gerar Prisma Client (typecheck do backend)',
      conclusion: 'success',
      completedAt: '2026-09-05T04:38:30Z',
    },
    {
      name: 'ESLint (0 warnings, 0 erros)',
      conclusion: 'success',
      completedAt: '2026-09-05T04:39:00Z',
    },
    {
      name: 'TypeScript frontend (strict, sem any implícito)',
      conclusion: 'success',
      completedAt: '2026-09-05T04:39:20Z',
    },
    {
      name: 'TypeScript backend (strict)',
      conclusion: 'success',
      completedAt: '2026-09-05T04:39:40Z',
    },
    {
      name: 'Prettier (formatação consistente)',
      conclusion: 'failure',
      completedAt: '2026-09-05T04:40:14Z',
    },
    {
      name: 'Cancelar workflow em caso de falha (Fail-Fast Cross-Job)',
      conclusion: 'success',
      completedAt: '2026-09-05T04:40:16Z',
    },
    {
      name: 'Post Setup pnpm + cache + install',
      conclusion: 'success',
      completedAt: '2026-09-05T04:40:17Z',
    },
    { name: 'Complete job', conclusion: 'success', completedAt: '2026-09-05T04:40:17Z' },
  ],
}

// O job-gate ("todos os jobs passaram?") também acaba com conclusão
// `failure` — mas só PORQUE a Qualidade já tinha falhado antes. Ele nunca
// pode ser confundido com a causa raiz.
const GATE: JobComPassos = {
  name: '🏁 CI passou — pronto para merge',
  conclusion: 'failure',
  steps: [
    { name: 'Set up job', conclusion: 'success', completedAt: '2026-09-05T04:40:19Z' },
    {
      name: 'Verificar resultado de todos os jobs',
      conclusion: 'failure',
      completedAt: '2026-09-05T04:40:21Z',
    },
    { name: 'Complete job', conclusion: 'success', completedAt: '2026-09-05T04:40:23Z' },
  ],
}

// Jobs cancelados SEM CULPA nenhuma: mortos em pleno voo pelo cancelamento
// em cadeia, nenhum passo próprio chegou a falhar.
const DB_ADVISOR: JobComPassos = {
  name: '🗄️ DB Advisor — Schema, índices e RLS',
  conclusion: 'cancelled',
  steps: [
    { name: 'Set up job', conclusion: 'success', completedAt: '2026-09-05T04:02:43Z' },
    { name: 'Rodar advisor', conclusion: 'cancelled', completedAt: '2026-09-05T04:40:15Z' },
  ],
}

const FRONTEND_SHARD_1: JobComPassos = {
  name: '🧪 Testes Frontend (shard 1/2)',
  conclusion: 'cancelled',
  steps: [
    { name: 'Set up job', conclusion: 'success', completedAt: '2026-09-05T04:02:43Z' },
    { name: 'Rodar testes', conclusion: 'cancelled', completedAt: '2026-09-05T04:40:15Z' },
  ],
}

describe('acharCulpadoDoCancelamento', () => {
  it('acha o passo que falhou PRIMEIRO entre vários jobs cancelados — não o job-gate que só confere depois', () => {
    // Ordem de entrada deliberadamente embaralhada (gate antes da
    // Qualidade) para provar que quem decide é o RELÓGIO do passo, nunca a
    // posição no array.
    const culpado = acharCulpadoDoCancelamento([DB_ADVISOR, GATE, QUALIDADE])
    expect(culpado).toEqual({
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
  })

  it('tudo cancelado e nenhum passo falhou de verdade: sem culpado (push novo ou concorrência)', () => {
    expect(acharCulpadoDoCancelamento([DB_ADVISOR, FRONTEND_SHARD_1])).toBeUndefined()
  })

  it('job sem passos buscados (steps undefined) não quebra a busca', () => {
    expect(
      acharCulpadoDoCancelamento([{ name: 'sem-passos-ainda', conclusion: 'cancelled' }])
    ).toBeUndefined()
  })

  it('lista vazia: sem culpado', () => {
    expect(acharCulpadoDoCancelamento([])).toBeUndefined()
  })
})

describe('frasarCausaDoCancelamento', () => {
  it('monta a frase em português simples, citando o passo real, sem jargão de integração contínua', () => {
    const frase = frasarCausaDoCancelamento({
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
    expect(frase).toContain('Prettier (formatação consistente)')
    expect(frase).toMatch(/cancelad[oa]/)
    expect(frase).not.toMatch(/\bpipeline\b/i)
    expect(frase).not.toMatch(/\bCI\b/)
  })
})

describe('investigarCancelamentoEmCadeia', () => {
  it('busca passos só dos jobs que NÃO passaram, e acha o culpado certo', async () => {
    const jobs: JobDoGithub[] = [
      { id: 1, name: 'sucesso-nao-interessa', conclusion: 'success' },
      { id: 2, name: DB_ADVISOR.name, conclusion: 'cancelled' },
      { id: 3, name: GATE.name, conclusion: 'failure' },
      { id: 4, name: QUALIDADE.name, conclusion: 'cancelled' },
    ]
    const pedidos: number[] = []
    const buscar = async (jobId: number): Promise<readonly PassoDoJob[]> => {
      pedidos.push(jobId)
      if (jobId === 2) return DB_ADVISOR.steps!
      if (jobId === 3) return GATE.steps!
      if (jobId === 4) return QUALIDADE.steps!
      return []
    }
    const culpado = await investigarCancelamentoEmCadeia(jobs, buscar)
    expect(culpado).toEqual({
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
    // Não gastou chamada de rede com o job que já passou.
    expect([...pedidos].sort()).toEqual([2, 3, 4])
  })

  it('job cuja busca de passos falha entra como "sem passos" — não derruba a investigação', async () => {
    const jobs: JobDoGithub[] = [
      { id: 9, name: 'quebra-a-busca', conclusion: 'cancelled' },
      { id: 4, name: QUALIDADE.name, conclusion: 'cancelled' },
    ]
    const buscar = async (jobId: number) => {
      if (jobId === 9) throw new Error('rede caiu')
      return QUALIDADE.steps!
    }
    const culpado = await investigarCancelamentoEmCadeia(jobs, buscar)
    expect(culpado).toEqual({
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
  })

  it('nenhum job precisa de investigação (tudo passou ou pulou): não busca nada', async () => {
    const jobs: JobDoGithub[] = [
      { id: 1, name: 'ok', conclusion: 'success' },
      { id: 2, name: 'pulado', conclusion: 'skipped' },
    ]
    let chamou = false
    const culpado = await investigarCancelamentoEmCadeia(jobs, async () => {
      chamou = true
      return []
    })
    expect(culpado).toBeUndefined()
    expect(chamou).toBe(false)
  })
})
