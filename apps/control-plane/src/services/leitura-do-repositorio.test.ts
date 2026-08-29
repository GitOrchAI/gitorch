import { describe, it, expect, vi } from 'vitest'
import {
  lerRepositorios,
  contarQuadros,
  paraLeitura,
  LeituraIndisponivelError,
  type DepsDaLeitura,
} from './leitura-do-repositorio.js'

// Os números abaixo NÃO são inventados: vieram da conta do próprio dono em
// 29/08, com a consulta disparada de verdade antes desta camada existir.
//   GitOrchAI/gitorch          → 72 pedidos, 19 entregas, 1 quadro vivo SEM
//                                sprint, TypeScript, main, 9 verificações
//   loureng/patinhas-3d-crafts → 97 pedidos, 6 entregas, 2 quadros (1 arquivado)

const GITORCH_REAL = {
  nameWithOwner: 'GitOrchAI/gitorch',
  isPrivate: false,
  primaryLanguage: { name: 'TypeScript' },
  issues: { totalCount: 72 },
  pullRequests: { totalCount: 19 },
  projectsV2: {
    totalCount: 1,
    nodes: [
      {
        id: 'PVT_1',
        number: 2,
        title: 'GitOrchAI/gitorch',
        closed: false,
        // O quadro do gitorch NÃO tem campo de iteração — foi por isso que a
        // visão Roadmap dele abria com "Dates: none".
        fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField' }] },
      },
    ],
  },
  defaultBranchRef: {
    name: 'main',
    target: { committedDate: '2026-08-29T18:36:49Z', checkSuites: { totalCount: 9 } },
  },
}

function deps(over: Partial<DepsDaLeitura> = {}): DepsDaLeitura {
  return {
    listarProjetos: vi.fn().mockResolvedValue([{ nome: 'gitorch', repo: 'GitOrchAI/gitorch' }]),
    lerToken: vi.fn().mockResolvedValue('token'),
    fetchImpl: vi.fn(
      async () => new Response(JSON.stringify({ data: { repository: GITORCH_REAL } }))
    ),
    ...over,
  }
}

describe('lerRepositorios — conta o que está lá, sem julgar', () => {
  it('os números batem com o que o GitHub mostra na tela do dono', async () => {
    const [leitura] = await lerRepositorios(deps(), { ownerId: 'u1' })
    expect(leitura).toEqual({
      projeto: 'gitorch',
      repo: 'GitOrchAI/gitorch',
      disponivel: true,
      privado: false,
      linguagem: 'TypeScript',
      pedidosAbertos: 72,
      entregasAbertas: 19,
      quadros: { total: 1, vivos: 1, comSprint: 0 },
      ramoPrincipal: 'main',
      temVerificacao: true,
      ultimoCommit: '2026-08-29T18:36:49Z',
    })
  })

  it('usa o ENDEREÇO do repositório na consulta, não o nome curto', async () => {
    // O 503 de 29/08 nasceu exatamente disto: mandar "gitorch" em vez de
    // "GitOrchAI/gitorch" faz a consulta nunca resolver.
    const chamadas: Array<{ url: unknown; init: RequestInit | undefined }> = []
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      chamadas.push({ url, init })
      return new Response(JSON.stringify({ data: { repository: GITORCH_REAL } }))
    })
    await lerRepositorios(deps({ fetchImpl: f as unknown as typeof fetch }), { ownerId: 'u1' })
    const corpo = JSON.parse(String(chamadas[0]!.init!.body))
    expect(corpo.variables).toEqual({ owner: 'GitOrchAI', name: 'gitorch' })
  })
})

describe('o que falha aparece como INDISPONÍVEL, nunca como zero', () => {
  it('HTTP 200 com repository nulo e errors é falha, não repositório vazio', async () => {
    // Medido ao vivo: repositório inexistente devolve 200 com
    // { data: { repository: null }, errors: [NOT_FOUND] }.
    // São DOIS projetos de propósito: com um só, "todos falharam" vira erro da
    // leitura inteira (e é o certo). Aqui o que se observa é a linha que
    // sobrou marcada como indisponível ao lado da que respondeu.
    let chamada = 0
    const f = vi.fn(async () => {
      chamada++
      return chamada === 1
        ? new Response(
            JSON.stringify({
              data: { repository: null },
              errors: [{ message: 'Could not resolve' }],
            })
          )
        : new Response(JSON.stringify({ data: { repository: GITORCH_REAL } }))
    })
    const [leitura] = await lerRepositorios(
      deps({
        listarProjetos: vi.fn().mockResolvedValue([
          { nome: 'sumido', repo: 'dono/sumido' },
          { nome: 'gitorch', repo: 'GitOrchAI/gitorch' },
        ]),
        fetchImpl: f,
      }),
      { ownerId: 'u1' }
    )
    expect(leitura!.disponivel).toBe(false)
    if (!leitura!.disponivel) expect(leitura!.motivo).toContain('não consegui abrir')
  })

  it('um repositório que falha NÃO derruba os outros', async () => {
    const projetos = [
      { nome: 'gitorch', repo: 'GitOrchAI/gitorch' },
      { nome: 'patinhas', repo: 'loureng/patinhas-3d-crafts' },
    ]
    let chamada = 0
    const f = vi.fn(async () => {
      chamada++
      return chamada === 1
        ? new Response(JSON.stringify({ data: { repository: null }, errors: [{}] }))
        : new Response(JSON.stringify({ data: { repository: GITORCH_REAL } }))
    })
    const leituras = await lerRepositorios(
      deps({ listarProjetos: vi.fn().mockResolvedValue(projetos), fetchImpl: f }),
      { ownerId: 'u1' }
    )
    expect(leituras).toHaveLength(2)
    expect(leituras[0]!.disponivel).toBe(false)
    expect(leituras[1]!.disponivel).toBe(true)
  })

  it('quando NENHUM responde, é erro — não lista vazia', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: { repository: null } })))
    await expect(lerRepositorios(deps({ fetchImpl: f }), { ownerId: 'u1' })).rejects.toBeInstanceOf(
      LeituraIndisponivelError
    )
  })

  it('endereço sem barra vira indisponível com motivo, não estoura', async () => {
    const leituras = await lerRepositorios(
      deps({
        listarProjetos: vi.fn().mockResolvedValue([
          { nome: 'torto', repo: 'gitorch' },
          { nome: 'certo', repo: 'GitOrchAI/gitorch' },
        ]),
      }),
      { ownerId: 'u1' }
    )
    expect(leituras[0]!.disponivel).toBe(false)
    if (!leituras[0]!.disponivel) expect(leituras[0]!.motivo).toContain('dono/repositório')
  })

  it('rede caída não estoura a leitura inteira', async () => {
    const f = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    await expect(lerRepositorios(deps({ fetchImpl: f }), { ownerId: 'u1' })).rejects.toBeInstanceOf(
      LeituraIndisponivelError
    )
  })

  it('sem credencial do dono, é indisponível — não zero', async () => {
    await expect(
      lerRepositorios(deps({ lerToken: vi.fn().mockResolvedValue(null) }), { ownerId: 'u1' })
    ).rejects.toBeInstanceOf(LeituraIndisponivelError)
  })

  it('dono sem projeto nenhum devolve lista vazia, e isso NÃO é erro', async () => {
    const r = await lerRepositorios(deps({ listarProjetos: vi.fn().mockResolvedValue([]) }), {
      ownerId: 'u1',
    })
    expect(r).toEqual([])
  })
})

describe('contarQuadros — arquivado não vale, e sprint precisa de ciclo', () => {
  it('quadro arquivado conta no total mas não entre os vivos', () => {
    // Caso real do patinhas: 2 quadros, um deles arquivado.
    expect(
      contarQuadros([
        { closed: true, fields: { nodes: [] } },
        { closed: false, fields: { nodes: [] } },
      ])
    ).toEqual({ total: 2, vivos: 1, comSprint: 0 })
  })

  it('campo de sprint VAZIO não conta como sprint', () => {
    // O quadro do Jardim tinha o campo criado com duração 0 e zero iterações:
    // existia e não funcionava. Contar isso como "tem sprint" seria mentira.
    expect(
      contarQuadros([
        {
          closed: false,
          fields: {
            nodes: [{ __typename: 'ProjectV2IterationField', configuration: { iterations: [] } }],
          },
        },
      ])
    ).toEqual({ total: 1, vivos: 1, comSprint: 0 })
  })

  it('campo de sprint COM ciclo conta', () => {
    expect(
      contarQuadros([
        {
          closed: false,
          fields: {
            nodes: [
              { __typename: 'ProjectV2IterationField', configuration: { iterations: [{}, {}] } },
            ],
          },
        },
      ]).comSprint
    ).toBe(1)
  })

  it('lista vazia é zero em tudo', () => {
    expect(contarQuadros([])).toEqual({ total: 0, vivos: 0, comSprint: 0 })
  })
})

describe('paraLeitura — o que falta vira null, nunca chute', () => {
  it('repositório sem commit nenhum não inventa ramo nem data', () => {
    const r = paraLeitura(
      { isPrivate: true, issues: { totalCount: 0 }, pullRequests: { totalCount: 0 } },
      { nome: 'novo', repo: 'dono/novo' }
    )
    expect(r.ramoPrincipal).toBeNull()
    expect(r.ultimoCommit).toBeNull()
    expect(r.linguagem).toBeNull()
    expect(r.temVerificacao).toBe(false)
    expect(r.privado).toBe(true)
  })

  it('"tem verificação" vem de execução real, não de arquivo no disco', () => {
    // Workflow parado no repositório não verifica nada. A pergunta é se o
    // último commit do ramo principal foi verificado.
    const semExecucao = paraLeitura(
      { defaultBranchRef: { name: 'main', target: { checkSuites: { totalCount: 0 } } } },
      { nome: 'x', repo: 'd/x' }
    )
    expect(semExecucao.temVerificacao).toBe(false)
  })
})
