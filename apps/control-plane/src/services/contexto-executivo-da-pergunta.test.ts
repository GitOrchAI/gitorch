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

/**
 * Fix-up (revisão, task a3902ca3-c6b4-4110-9d30-313a5a8f3787) — item 1: a
 * frase da entrega parava no PRIMEIRO ponto, mesmo dentro de um número
 * decimal — "Aumentar a conversão de 2.5% para 4% no checkout." virava
 * "Aumentar a conversão de 2.". Cada caso abaixo é RED antes do conserto de
 * `primeiraFrase`.
 */
describe('montarContextoExecutivoDaPergunta — a primeira frase não quebra no meio de número/sigla/endereço', () => {
  it('número decimal no meio da frase: não corta em "2."', async () => {
    const corpo =
      '## Goal\n\nAumentar a conversão de 2.5% para 4% no checkout. Detalhe técnico irrelevante.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBe('Aumentar a conversão de 2.5% para 4% no checkout.')
  })

  it('número de versão no meio da frase: não corta em "v2."', async () => {
    const corpo = '## Goal\n\nAtualizar o app para a versão v2.5.1 antes do fim do mês. Blá.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBe('Atualizar o app para a versão v2.5.1 antes do fim do mês.')
  })

  it('sigla com ponto entre as letras: não corta em "E."', async () => {
    const corpo = '## Goal\n\nAbrir a loja também para clientes dos E.U.A. e do Canadá. Blá.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBe('Abrir a loja também para clientes dos E.U.A. e do Canadá.')
  })

  it('endereço com abreviação: não corta em "Av."', async () => {
    const corpo = '## Goal\n\nInstalar o totem na loja da Av. Paulista, 1000. Detalhe irrelevante.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).toBe('Instalar o totem na loja da Av. Paulista, 1000.')
  })
})

/**
 * Item 2: a decisão anterior é gravada como o VALUE interno do botão
 * clicado (ex.: "seguir-suposicao-ra"), nunca o label. O texto final
 * ("A equipe já resolveu sozinha: seguir-suposicao-ra.") mostra código ao
 * dono. Mesmo padrão de `telegram-bot.ts`/`retomar-sessao-com-resposta.ts`:
 * casar valor↔rótulo pelas opções da PRÓPRIA pergunta.
 */
describe('montarContextoExecutivoDaPergunta — decisão anterior vira o rótulo legível, nunca o código', () => {
  const OPCOES_REAIS = [
    { label: 'Pausar esta tarefa até eu decidir com calma', value: 'pausar' },
    { label: 'Seguir com a melhor decisão da equipe por agora', value: 'seguir-suposicao-ra' },
    { label: 'Entregar o que já está pronto para revisão', value: 'pedir-pr' },
  ]

  it('o value bate com uma opção da própria pergunta: usa o label, nunca o código', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [{ answer: 'seguir-suposicao-ra', options: OPCOES_REAIS }]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual(['Seguir com a melhor decisão da equipe por agora'])
    expect(contexto.decisoes.join(' ')).not.toContain('seguir-suposicao-ra')
  })

  it('resposta em texto livre (não bate com nenhuma opção, não parece código): mantém o texto como está', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [
            {
              answer: 'Vamos usar o parceiro novo mesmo, já validamos o preço com o financeiro.',
              options: OPCOES_REAIS,
            },
          ]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual([
      'Vamos usar o parceiro novo mesmo, já validamos o preço com o financeiro.',
    ])
  })

  it('value órfão (não bate com nenhuma opção e parece código): omite em vez de mostrar código', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [
            { answer: 'valor-que-nao-existe-mais', options: OPCOES_REAIS },
            { answer: 'Cobrar frete fixo para todo o Brasil.', options: OPCOES_REAIS },
          ]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual(['Cobrar frete fixo para todo o Brasil.'])
    expect(contexto.decisoes.join(' ')).not.toContain('valor-que-nao-existe-mais')
  })

  it('sem options na linha (pergunta aberta, sem botões): mantém o texto como sempre foi', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [{ answer: 'Usar o serviço de imagens do catálogo.' }]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes).toEqual(['Usar o serviço de imagens do catálogo.'])
  })
})

/**
 * Item 3: objetivo da issue e decisão anterior são texto de TERCEIRO — só
 * limpeza de caracteres não impedia a palavra proibida ("dev"/
 * "desenvolvedor"/"técnica") de atravessar para o texto final, quebrando a
 * MESMA promessa de D72/D73 (`texto-de-escalada.ts`).
 */
describe('montarContextoExecutivoDaPergunta — palavra proibida é barrada mesmo vinda de dado externo', () => {
  it('objetivo da issue com "desenvolvedor": filtrado, frase continua com sentido', async () => {
    const corpo = '## Goal\n\nO desenvolvedor valida o webhook antes de publicar a nova versão.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).not.toBeNull()
    expect(contexto.entrega).not.toMatch(/desenvolvedor/i)
    expect(contexto.entrega).toBe('O responsável valida o webhook antes de publicar a nova versão.')
  })

  it('objetivo da issue com "dev": filtrado', async () => {
    const corpo = '## Goal\n\nO dev sobe o pacote assim que o teste passar.'
    const deps = depsFalso({ buscarCorpoDaIssue: vi.fn(async () => corpo) })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.entrega).not.toMatch(/\bdev\b/i)
    expect(contexto.entrega).toBe('O responsável sobe o pacote assim que o teste passar.')
  })

  it('decisão anterior com "técnica": filtrada', async () => {
    const deps = depsFalso({
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [
            { answer: 'Precisa de uma revisão técnica antes de liberar.' },
          ]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.decisoes[0]).not.toMatch(/técnic/i)
    expect(contexto.decisoes[0]).toBe('Precisa de uma revisão operacional antes de liberar.')
  })
})

/**
 * Item 4: o corte por tamanho usava `.length`/`.slice()` em unidades de
 * código (UTF-16) — um emoji fora do BMP é um par substituto (2 unidades),
 * e cortar no meio dele deixa uma surrogate solta (glifo quebrado).
 */
describe('montarContextoExecutivoDaPergunta — o corte por tamanho respeita o caractere inteiro (emoji)', () => {
  it('emoji bem no ponto de corte: nunca uma surrogate solta', async () => {
    const emoji = '😀'
    const prefixo = 'B'.repeat(178) // teto da decisão = 180
    const sufixo = 'CCCCCC' // garante que o texto total ultrapassa o teto
    const respostaComEmoji = `${prefixo}${emoji}${sufixo}`
    const deps = depsFalso({
      prisma: {
        agentQuestion: { findMany: vi.fn(async () => [{ answer: respostaComEmoji }]) },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    const decisao = contexto.decisoes[0]!
    expect(decisao.endsWith('…')).toBe(true)
    // nenhuma high-surrogate sem a low-surrogate correspondente logo depois,
    // e vice-versa — prova de que o emoji nunca foi partido ao meio.
    expect(decisao).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(decisao).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

/**
 * Item 5: ciclo/entrega/decisões eram lidos em FILA (3 `await` em série),
 * somando a latência das 3 fontes — nenhuma depende da outra. Este teste
 * prova (a) que rodam em paralelo (tempo total ~= a mais lenta, não a soma)
 * e (b) que uma fonte falhando não impede as demais de completar.
 */
describe('montarContextoExecutivoDaPergunta — as 3 leituras rodam em paralelo', () => {
  it('uma fonte falhando não impede as outras 2 de completar com sucesso', async () => {
    const deps = depsFalso({
      clienteDeQuadro: {
        getIterationField: vi.fn(async () => {
          throw new Error('quadro fora do ar')
        }),
      },
      quadroId: 'PVT_x',
      buscarCorpoDaIssue: vi.fn(async () => '## Goal\n\nEntregar o relatório mensal.'),
      prisma: {
        agentQuestion: {
          findMany: vi.fn(async () => [{ answer: 'Decisão registrada com sucesso.' }]),
        },
      },
    })

    const contexto = await montarContextoExecutivoDaPergunta(ARGS, deps)

    expect(contexto.ciclo).toBeNull()
    expect(contexto.lacunas).toContain(LACUNA_FALHA_AO_LER_CICLO)
    expect(contexto.entrega).toBe('Entregar o relatório mensal.')
    expect(contexto.decisoes).toEqual(['Decisão registrada com sucesso.'])
  })

  it('as 3 fontes rodam em paralelo: o tempo total é ~ a mais lenta, não a soma das 3', async () => {
    const ATRASO_MS = 60
    const comAtraso = <T>(valor: T): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(valor), ATRASO_MS))

    const deps = depsFalso({
      clienteDeQuadro: {
        getIterationField: vi.fn(() =>
          comAtraso({
            fieldId: 'f1',
            iterations: [{ id: 'it1', title: 'Sprint 4', startDate: '2026-09-01', duration: 3 }],
          })
        ),
      },
      quadroId: 'PVT_x',
      hoje: '2026-09-02',
      buscarCorpoDaIssue: vi.fn(() => comAtraso('## Goal\n\nEntregar o relatório mensal.')),
      prisma: {
        agentQuestion: {
          findMany: vi.fn(() => comAtraso([{ answer: 'Decisão registrada com sucesso.' }])),
        },
      },
    })

    const inicio = Date.now()
    await montarContextoExecutivoDaPergunta(ARGS, deps)
    const duracao = Date.now() - inicio

    // sequencial custaria >= 3*ATRASO_MS (180ms); paralelo fica perto de 1x
    // (60ms) — folga generosa para não ficar frágil em CI mais lento.
    expect(duracao).toBeLessThan(ATRASO_MS * 2.5)
  })
})
