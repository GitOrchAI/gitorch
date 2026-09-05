import { describe, it, expect } from 'vitest'
import {
  acharCulpadoDoCancelamento,
  frasarCausaDoCancelamento,
  investigarCancelamentoEmCadeia,
  LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO,
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
      encontrado: true,
      ambiguo: false,
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
  })

  it('tudo cancelado e nenhum passo falhou de verdade: sem culpado (push novo ou concorrência)', () => {
    expect(acharCulpadoDoCancelamento([DB_ADVISOR, FRONTEND_SHARD_1])).toEqual({
      encontrado: false,
    })
  })

  it('job sem passos buscados (steps undefined) não quebra a busca', () => {
    expect(
      acharCulpadoDoCancelamento([{ name: 'sem-passos-ainda', conclusion: 'cancelled' }])
    ).toEqual({ encontrado: false })
  })

  it('lista vazia: sem culpado', () => {
    expect(acharCulpadoDoCancelamento([])).toEqual({ encontrado: false })
  })

  // Achado 2 da revisão (L4-T17 fix-up): a comparação usava texto vazio
  // quando faltava horário, e '' ordena antes de qualquer data ISO real —
  // um passo sem `completedAt` virava "o mais antigo" só por default de
  // comparação, nunca por evidência de que terminou primeiro.
  it('achado 2: passo sem horário nunca vira "o mais antigo" — não pode ganhar de um passo com horário real', () => {
    const semHorario: JobComPassos = {
      name: 'job sem horário',
      conclusion: 'cancelled',
      steps: [{ name: 'passo sem horário', conclusion: 'failure', completedAt: undefined }],
    }
    const comHorario: JobComPassos = {
      name: 'job com horário',
      conclusion: 'cancelled',
      steps: [
        { name: 'passo com horário', conclusion: 'failure', completedAt: '2026-09-05T04:40:14Z' },
      ],
    }
    // As duas ordens de entrada — sem horário não pode ganhar nem "chegando
    // primeiro" no array.
    expect(acharCulpadoDoCancelamento([semHorario, comHorario])).toEqual({
      encontrado: true,
      ambiguo: false,
      job: 'job com horário',
      passo: 'passo com horário',
    })
    expect(acharCulpadoDoCancelamento([comHorario, semHorario])).toEqual({
      encontrado: true,
      ambiguo: false,
      job: 'job com horário',
      passo: 'passo com horário',
    })
  })

  // Achado 2, caso limite: TODOS os candidatos sem horário — não há
  // absolutamente nenhum critério para ordenar (nem data, nem outro campo
  // confiável), então nenhum pode ser apontado como "o mais antigo".
  it('achado 2b: nenhum candidato tem horário — sem critério, não aponta um ao acaso', () => {
    const jobA: JobComPassos = {
      name: 'job A',
      conclusion: 'cancelled',
      steps: [{ name: 'passo A', conclusion: 'failure', completedAt: null }],
    }
    const jobB: JobComPassos = {
      name: 'job B',
      conclusion: 'cancelled',
      steps: [{ name: 'passo B', conclusion: 'failure', completedAt: undefined }],
    }
    const resultado = acharCulpadoDoCancelamento([jobA, jobB])
    expect(resultado.encontrado).toBe(true)
    expect(resultado.encontrado && resultado.ambiguo).toBe(true)
  })

  // Achado 3 da revisão (L4-T17 fix-up): empate no MESMO instante caía na
  // ordem de chegada da resposta da API (sort estável preserva a ordem de
  // entrada) — sem relação causal nenhuma. Testa as duas ordens de entrada
  // para provar que NENHUMA delas decide sozinha: as duas têm que devolver
  // "ambíguo", nunca uma escolha silenciosa.
  it('achado 3: empate no mesmo instante — sem critério confiável, declara mais de um candidato em vez de escolher um ao acaso', () => {
    const jobX: JobComPassos = {
      name: 'job X',
      conclusion: 'cancelled',
      steps: [{ name: 'passo X', conclusion: 'failure', completedAt: '2026-09-05T04:40:14Z' }],
    }
    const jobY: JobComPassos = {
      name: 'job Y',
      conclusion: 'cancelled',
      steps: [{ name: 'passo Y', conclusion: 'failure', completedAt: '2026-09-05T04:40:14Z' }],
    }
    expect(acharCulpadoDoCancelamento([jobX, jobY])).toEqual({
      encontrado: true,
      ambiguo: true,
      candidatos: [
        { job: 'job X', passo: 'passo X' },
        { job: 'job Y', passo: 'passo Y' },
      ],
    })
    // Ordem invertida: se a resposta fosse "o primeiro do array", este
    // segundo caso devolveria 'job Y' — a asserção abaixo prova que não é
    // isso que acontece.
    expect(acharCulpadoDoCancelamento([jobY, jobX])).toEqual({
      encontrado: true,
      ambiguo: true,
      candidatos: [
        { job: 'job Y', passo: 'passo Y' },
        { job: 'job X', passo: 'passo X' },
      ],
    })
  })

  // Um único candidato nunca é ambíguo, mesmo sem horário — não há com o
  // que empatar.
  it('um único passo que falhou de verdade nunca é "ambíguo", mesmo sem horário', () => {
    const resultado = acharCulpadoDoCancelamento([
      {
        name: 'job único',
        conclusion: 'cancelled',
        steps: [{ name: 'passo', conclusion: 'failure' }],
      },
    ])
    expect(resultado).toEqual({
      encontrado: true,
      ambiguo: false,
      job: 'job único',
      passo: 'passo',
    })
  })
})

describe('frasarCausaDoCancelamento', () => {
  it('monta a frase em português simples, citando o passo real, sem jargão de integração contínua', () => {
    const frase = frasarCausaDoCancelamento({
      encontrado: true,
      ambiguo: false,
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
    expect(frase).toContain('Prettier (formatação consistente)')
    expect(frase).toMatch(/cancelad[oa]/)
    expect(frase).not.toMatch(/\bpipeline\b/i)
    expect(frase).not.toMatch(/\bCI\b/)
  })

  // Achado 3: quando o empate é honesto (mais de um candidato, nenhum
  // critério confiável para escolher), a frase tem que DIZER isso — nunca
  // apontar um dos dois como se fosse certeza.
  it('empate: a frase diz que há mais de um candidato, não aponta um sozinho', () => {
    const frase = frasarCausaDoCancelamento({
      encontrado: true,
      ambiguo: true,
      candidatos: [
        { job: 'job X', passo: 'passo X' },
        { job: 'job Y', passo: 'passo Y' },
      ],
    })
    expect(frase).toContain('passo X')
    expect(frase).toContain('passo Y')
    expect(frase).not.toMatch(/\bpipeline\b/i)
    expect(frase).not.toMatch(/\bCI\b/)
  })

  // Achado 4 da revisão (L4-T17 fix-up) — SEGURANÇA: nome de job/passo vem
  // CRU do workflow do cliente e vira comentário PÚBLICO. Uma arroba
  // seguida de nome faz o GitHub resolver menção e notificar alguém de
  // verdade — mesmo risco que `sanitizarRespostaLivre` já trata para a
  // resposta livre do dono (decisao-de-automacao.ts).
  it('achado 4: nome de job/passo com @menção não pode sobreviver cru — mesma neutralização da resposta livre', () => {
    const frase = frasarCausaDoCancelamento({
      encontrado: true,
      ambiguo: false,
      job: 'job qualquer',
      passo: '@alguem urgente corrigir isso',
    })
    expect(frase).not.toContain('@alguem')
    expect(frase).toContain('@​alguem')
  })

  it('achado 4b: nome de job/passo gigante (workflow hostil) ganha teto de tamanho', () => {
    const passoGigante = 'x'.repeat(5000)
    const frase = frasarCausaDoCancelamento({
      encontrado: true,
      ambiguo: false,
      job: 'job',
      passo: passoGigante,
    })
    // Bem menor que os 5000 originais — o teto é pequeno e explícito, não
    // os 2000 da resposta livre inteira (nome de job/passo nunca precisa
    // ser um texto longo).
    expect(frase.length).toBeLessThan(1000)
  })

  it('achado 4c: crase dentro do nome não escapa da marcação de código', () => {
    const frase = frasarCausaDoCancelamento({
      encontrado: true,
      ambiguo: false,
      job: 'job',
      passo: 'passo`; @alguem',
    })
    // Se a crase do nome escapasse do code span, o `@alguem` ficaria fora
    // dele — mas a neutralização de menção já rodou ANTES da troca de
    // crase, então mesmo "escapando" ele não vira menção funcional.
    expect(frase).not.toContain('@alguem')
    expect(frase).toContain('@​alguem')
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
      encontrado: true,
      ambiguo: false,
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
      encontrado: true,
      ambiguo: false,
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
    expect(culpado).toEqual({ encontrado: false })
    expect(chamou).toBe(false)
  })

  // Achado 5 da revisão (L4-T17 fix-up): UMA chamada por job não-passante,
  // todas ao mesmo tempo — com matriz/muitos shards vira uma rajada de
  // dezenas de chamadas simultâneas contra o MESMO token do GitHub. Prova
  // um TETO pequeno e explícito de concorrência: nunca mais que
  // `LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO` chamadas em voo ao mesmo tempo.
  it('achado 5: nunca dispara mais chamadas simultâneas que o limite de concorrência, mesmo com muitos jobs', async () => {
    const totalDeJobs = LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO * 3
    const jobs: JobDoGithub[] = Array.from({ length: totalDeJobs }, (_, i) => ({
      id: i + 1,
      name: `job ${i + 1}`,
      conclusion: 'cancelled',
    }))
    let emAndamento = 0
    let picoDeConcorrencia = 0
    const buscar = async (): Promise<readonly PassoDoJob[]> => {
      emAndamento++
      picoDeConcorrencia = Math.max(picoDeConcorrencia, emAndamento)
      await new Promise((resolve) => setTimeout(resolve, 5))
      emAndamento--
      return []
    }
    await investigarCancelamentoEmCadeia(jobs, buscar)
    expect(picoDeConcorrencia).toBeGreaterThan(0)
    expect(picoDeConcorrencia).toBeLessThanOrEqual(LIMITE_DE_CONCORRENCIA_NA_INVESTIGACAO)
  })

  // Degrada com elegância: mesmo com o limite de concorrência, uma falha
  // isolada não pode derrubar a investigação inteira nem travar as demais.
  it('achado 5b: com o limite de concorrência, uma falha isolada ainda degrada com elegância (não trava as outras)', async () => {
    const jobs: JobDoGithub[] = [
      { id: 1, name: 'quebra', conclusion: 'cancelled' },
      { id: 2, name: QUALIDADE.name, conclusion: 'cancelled' },
      { id: 3, name: 'outro-cancelado', conclusion: 'cancelled' },
    ]
    const buscar = async (jobId: number) => {
      if (jobId === 1) throw new Error('rede caiu')
      if (jobId === 2) return QUALIDADE.steps!
      return []
    }
    const culpado = await investigarCancelamentoEmCadeia(jobs, buscar)
    expect(culpado).toEqual({
      encontrado: true,
      ambiguo: false,
      job: '✅ Qualidade — Lint + Typecheck + Prettier',
      passo: 'Prettier (formatação consistente)',
    })
  })
})
