import { describe, it, expect, vi } from 'vitest'
import {
  montarContextoExecutivoDaPergunta,
  contextoExecutivoVazio,
  LACUNA_SEM_SPRINT_CONFIGURADA,
  LACUNA_SEM_CICLO_CORRENTE,
  LACUNA_FALHA_AO_LER_CICLO,
  LACUNA_SEM_OBJETIVO_LEGIVEL,
  LACUNA_SEM_DECISAO_REGISTRADA,
  LACUNA_FALHA_AO_LER_DECISOES,
  type DepsDoContextoExecutivo,
} from './contexto-executivo-da-pergunta.js'

/**
 * L4-T23 — o dono recusou a pergunta "O dev está travado numa dúvida
 * técnica..." (task #3716 de loureng/patinhas-3d-crafts): quer a LÓGICA —
 * o ciclo corrente, o que a tarefa entrega, o que o time já resolveu
 * sozinho — nunca a dúvida técnica em si.
 *
 * Este montador reúne as 4 peças da história executiva. Cada peça É
 * INJETADA (mesmo padrão de `garantir-sprint.ts`/`escalar-duvida-ao-dono.ts`
 * — `ClienteDeQuadro`, `PrismaLike`): esta suite nunca bate em rede/banco
 * de verdade, só em fakes determinísticos — a chamada real (GitHub/Prisma)
 * é responsabilidade de quem liga isto em produção.
 *
 * Contrato central, testado em vários pontos abaixo: NUNCA lança e NUNCA
 * inventa — o que não pôde ser lido vira uma frase em `lacunas`, e a peça
 * correspondente fica `null`/`[]`.
 */

function depsFalso(overrides: Partial<DepsDoContextoExecutivo> = {}): DepsDoContextoExecutivo {
  return {
    buscarCorpoDaIssue: vi.fn(async () => null),
    prisma: { agentQuestion: { findMany: vi.fn(async () => []) } },
    ...overrides,
  }
}

const ARGS = { projectId: 'proj1', repository: 'loureng/patinhas-3d-crafts', issueNumber: 3716 }

describe('montarContextoExecutivoDaPergunta — o ciclo corrente', () => {
  it('há uma sprint rodando hoje: título + período (dd/mm a dd/mm)', async () => {
    const deps = depsFalso({
      clienteDeQuadro: {
        getIterationField: vi.fn(async () => ({
          fieldId: 'f1',
          iterations: [{ id: 'it1', title: 'Sprint 4', startDate: '2026-09-01', duration: 3 }],
        })),
      },
      quadroId: 'PVT_kwquadro',
      hoje: '2026-09-02',
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.ciclo).toBe('Sprint 4 (01/09 a 04/09)')
    expect(contexto.lacunas).not.toContain(LACUNA_SEM_SPRINT_CONFIGURADA)
  })

  it('sem clienteDeQuadro/quadroId (projeto sem quadro vinculado): ciclo null + lacuna', async () => {
    const deps = depsFalso()

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.ciclo).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_SEM_SPRINT_CONFIGURADA)
  })

  it('quadro tem o campo mas nenhuma iteração cobre hoje: ciclo null + lacuna própria', async () => {
    const deps = depsFalso({
      clienteDeQuadro: {
        getIterationField: vi.fn(async () => ({
          fieldId: 'f1',
          iterations: [{ id: 'it1', title: 'Sprint 1', startDate: '2026-01-01', duration: 3 }],
        })),
      },
      quadroId: 'PVT_kwquadro',
      hoje: '2026-09-02',
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.ciclo).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_SEM_CICLO_CORRENTE)
  })

  it('getIterationField lança (rede/GraphQL): ciclo null + lacuna — NUNCA derruba a função inteira', async () => {
    const deps = depsFalso({
      clienteDeQuadro: {
        getIterationField: vi.fn(async () => {
          throw new Error('502 do GraphQL')
        }),
      },
      quadroId: 'PVT_kwquadro',
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.ciclo).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_FALHA_AO_LER_CICLO)
  })
})

describe('montarContextoExecutivoDaPergunta — o que a tarefa entrega', () => {
  it('lê a seção "## Goal" do corpo da issue e usa só a primeira frase', async () => {
    const corpo =
      '<!-- marker -->\n\n## Goal\n\nO cliente sobe uma foto do produto e vê a prévia antes de publicar. Detalhe técnico irrelevante aqui.\n\n## Task Details\n\nblá'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBe(
      'O cliente sobe uma foto do produto e vê a prévia antes de publicar.'
    )
    expect(contexto.lacunas).not.toContain(LACUNA_SEM_OBJETIVO_LEGIVEL)
  })

  it('corpo sem seção "## Goal": entrega null + lacuna', async () => {
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => '<!-- marker -->\n\nsem goal') })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_SEM_OBJETIVO_LEGIVEL)
  })

  it('issue não encontrada (buscarCorpoDaIssue devolve null): entrega null + lacuna', async () => {
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => null) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_SEM_OBJETIVO_LEGIVEL)
  })

  it('buscarCorpoDaIssue lança (sem credencial, GitHub fora do ar): entrega null + lacuna, nunca derruba', async () => {
    const deps = depsFalso({
      buscarCorpoDaIssue: vi.fn(async () => {
        throw new Error('sem credencial que alcance este repositório')
      }),
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_SEM_OBJETIVO_LEGIVEL)
  })
})

describe('montarContextoExecutivoDaPergunta — o que o time já decidiu', () => {
  it('há decisões anteriores respondidas para esta issue: vira lista de frases', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [
            { answer: 'Usar o mesmo serviço de imagens do catálogo.' },
            { answer: 'Cobrar frete fixo para todo o Brasil.' },
          ]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual([
      'Usar o mesmo serviço de imagens do catálogo.',
      'Cobrar frete fixo para todo o Brasil.',
    ])
    expect(contexto.lacunas).not.toContain(LACUNA_SEM_DECISAO_REGISTRADA)
  })

  it('busca só decisões desta issue — a chave de busca usa repo/issue corretos', async () => {
    const findMany = vi.fn(async (_args: unknown) => [])
    const deps = depsFalso({ prisma: { agentQuestion: { findMany } } })

    await montarContextoExecutivoDaPergunta(ARGS, deps)

    const chamada = findMany.mock.calls[0]?.[0] as {
      where: { projectId: string; status: string; dedupKey: { startsWith: string } }
    }
    expect(chamada.where.projectId).toBe('proj1')
    expect(chamada.where.status).toBe('answered')
    expect(chamada.where.dedupKey.startsWith).toBe('duvida-dev:loureng/patinhas-3d-crafts:3716:')
  })

  it('nenhuma decisão anterior: lista vazia + lacuna', async () => {
    const deps = depsFalso()

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual([])
    expect(contexto.lacunas).toContain(LACUNA_SEM_DECISAO_REGISTRADA)
  })

  it('respostas vazias/só espaço são descartadas — nunca uma decisão em branco', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: { findMany: vi.fn(async () => [{ answer: '   ' }, { answer: null }]) },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual([])
    expect(contexto.lacunas).toContain(LACUNA_SEM_DECISAO_REGISTRADA)
  })

  it('no máximo 3 decisões, mesmo com mais respostas anteriores', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [
            { answer: 'Decisão 1.' },
            { answer: 'Decisão 2.' },
            { answer: 'Decisão 3.' },
            { answer: 'Decisão 4.' },
          ]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toHaveLength(3)
  })

  it('Prisma lança (banco fora do ar): decisões vazias + lacuna própria, nunca derruba', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => {
            throw new Error('conexão recusada')
          }),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual([])
    expect(contexto.lacunas).toContain(LACUNA_FALHA_AO_LER_DECISOES)
  })
})

describe('montarContextoExecutivoDaPergunta — teto de tamanho e sanitização (texto de terceiro)', () => {
  it('entrega além do teto é cortada com reticências', async () => {
    const fraseGigante = 'A'.repeat(500) + '.'
    const corpo = `## Goal\n\n${fraseGigante}`
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega!.length).toBeLessThanOrEqual(220)
    expect(contexto.entrega!.endsWith('…')).toBe(true)
  })

  it('decisão além do teto é cortada com reticências', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: { findMany: vi.fn(async () => [{ answer: 'B'.repeat(400) }]) },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes[0]!.length).toBeLessThanOrEqual(180)
    expect(contexto.decisoes[0]!.endsWith('…')).toBe(true)
  })

  it('quebras de linha e espaços múltiplos de texto de terceiro viram um espaço só', async () => {
    const corpo = '## Goal\n\nO cliente\ncadastra   um produto\n\tnovo.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBe('O cliente cadastra um produto novo.')
  })

  it('caracteres de controle são removidos', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [{ answer: 'Usar\u0000o fornecedor\u0007X.' }]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes[0]).toBe('Usar o fornecedor X.')
  })
})

describe('montarContextoExecutivoDaPergunta — nunca lança', () => {
  it('as 3 fontes falhando ao mesmo tempo: resolve com as 3 lacunas, nunca rejeita', async () => {
    const deps: DepsDoContextoExecutivo = {
      clienteDeQuadro: {
        getIterationField: vi.fn(async () => {
          throw new Error('rede caiu')
        }),
      },
      quadroId: 'PVT_x',
      buscarCorpoDaIssue: vi.fn(async () => {
        throw new Error('404')
      }),
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => {
            throw new Error('timeout')
          }),
        },
      },
    }

    await expect(montarContextoExecutivoDaPergunta(ARGS, deps)).resolves.toEqual({
      ciclo: null,
      entrega: null,
      decisoes: [],
      lacunas: [
        LACUNA_FALHA_AO_LER_CICLO,
        LACUNA_SEM_OBJETIVO_LEGIVEL,
        LACUNA_FALHA_AO_LER_DECISOES,
      ],
    })
  })
})

describe('contextoExecutivoVazio — o fallback totalmente vazio, nunca inventa', () => {
  it('todas as 3 peças são lacuna, nada preenchido', () => {
    expect(contextoExecutivoVazio()).toEqual({
      ciclo: null,
      entrega: null,
      decisoes: [],
      lacunas: [
        LACUNA_SEM_SPRINT_CONFIGURADA,
        LACUNA_SEM_OBJETIVO_LEGIVEL,
        LACUNA_SEM_DECISAO_REGISTRADA,
      ],
    })
  })
})
