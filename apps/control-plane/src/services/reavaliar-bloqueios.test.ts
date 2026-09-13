// DJ-T12: reavaliação dos "Blocked by" já publicados — a fila indiana medida
// no GitHub (26/32 e 22/23 tasks abertas dependentes de outra) só se desfaz
// quando alguém relê cada bloqueio já criado e solta o que não é dependência
// real. TDD com fetch e executor falsos: nenhuma chamada real ao GitHub nem
// a motor nenhum.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aplicarDecisoesNoCorpo,
  deveRodarReavaliacaoAgora,
  ENV_POR_RODADA_DE_REAVALIACAO,
  lerBloqueiosComMotivo,
  rodarReavaliacaoDeProjetoSeForAHora,
  runReavaliarBloqueios,
  sinalDeCruzamento,
  TIPO_EVENTO_ULTIMA_EXECUCAO,
} from './reavaliar-bloqueios.js'

interface FakeIssue {
  number: number
  title: string
  body: string
  labels: string[]
  state?: 'open' | 'closed'
}

function fakeFetch(issues: FakeIssue[]) {
  const byNumber = new Map(issues.map((i) => [i.number, i]))
  const comments: Array<{ number: number; body: string }> = []
  const patches: Array<{ number: number; body: string }> = []
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status })

    // Lista de tasks abertas com label gitorch:task
    if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
      return json(
        issues.map((i) => ({
          number: i.number,
          title: i.title,
          body: i.body,
          labels: i.labels.map((n) => ({ name: n })),
        }))
      )
    }
    // Comentário numa issue
    const cm = u.match(/\/issues\/(\d+)\/comments$/)
    if (cm && method === 'POST') {
      const n = Number(cm[1])
      const body = init?.body ? (JSON.parse(String(init.body)) as { body: string }).body : ''
      comments.push({ number: n, body })
      return json({})
    }
    // Estado/corpo de uma issue individual (GET), ou edição do corpo (PATCH)
    const im = u.match(/\/issues\/(\d+)$/)
    if (im) {
      const n = Number(im[1])
      const issue = byNumber.get(n)
      if (method === 'PATCH') {
        const body = init?.body ? (JSON.parse(String(init.body)) as { body: string }).body : ''
        patches.push({ number: n, body })
        if (issue) issue.body = body
        return json({})
      }
      return json({
        number: n,
        state: issue?.state ?? 'open',
        title: issue?.title,
        body: issue?.body,
      })
    }
    return json({})
  }) as typeof fetch
  return { impl, comments, patches, byNumber }
}

function execExpr(mapa: Record<string, { decisao: 'manter' | 'remover'; motivo: string }>) {
  return vi.fn(async (prompt: string) => {
    const par = Object.keys(mapa).find((chave) => prompt.includes(chave))
    if (!par) throw new Error(`prompt inesperado no fake executor: ${prompt.slice(0, 200)}`)
    return JSON.stringify(mapa[par])
  })
}

describe('lerBloqueiosComMotivo', () => {
  it('lê número, motivo e marcador de um bloqueio já reavaliado', () => {
    const corpo =
      'Goal\n\nBlocked by #12\n- #12: usa o contrato de dados\n<!-- gitorch:reavaliado:12 -->'
    expect(lerBloqueiosComMotivo(corpo)).toEqual([
      { numero: 12, motivo: 'usa o contrato de dados', marcado: true },
    ])
  })

  it('formato legado (D74, um único bloqueio sem número no motivo)', () => {
    const corpo = 'Blocked by #7\n- precisa da migração criada em #7'
    expect(lerBloqueiosComMotivo(corpo)).toEqual([
      { numero: 7, motivo: 'precisa da migração criada em #7', marcado: false },
    ])
  })

  it('sem "Blocked by" → lista vazia', () => {
    expect(lerBloqueiosComMotivo('nada aqui')).toEqual([])
  })
})

describe('aplicarDecisoesNoCorpo', () => {
  it('remover tira o número; sobrando zero, tira a linha inteira', () => {
    const corpo = '<!-- marker -->\n\n## Goal\n\nfoo\n\nBlocked by #12'
    const novo = aplicarDecisoesNoCorpo(corpo, [
      { numero: 12, decisao: 'remover', motivo: 'áreas diferentes' },
    ])
    expect(novo).not.toMatch(/Blocked by/)
    expect(novo).toContain('## Goal')
  })

  it('remover UM de dois bloqueios mantém o outro', () => {
    const corpo = 'Blocked by #12, #20'
    const novo = aplicarDecisoesNoCorpo(corpo, [{ numero: 12, decisao: 'remover', motivo: 'x' }])
    expect(novo).toContain('Blocked by #20')
    expect(novo).not.toContain('#12')
  })

  it('manter grava a linha de motivo e o marcador, sem duplicar numa segunda chamada', () => {
    const corpo = 'Blocked by #12'
    const uma = aplicarDecisoesNoCorpo(corpo, [
      { numero: 12, decisao: 'manter', motivo: 'usa o contrato de dados' },
    ])
    expect(uma).toContain('- #12: usa o contrato de dados')
    expect(uma).toContain('<!-- gitorch:reavaliado:12 -->')

    // segunda rodada: mesma decisão aplicada de novo não duplica linha
    const duas = aplicarDecisoesNoCorpo(uma, [
      { numero: 12, decisao: 'manter', motivo: 'usa o contrato de dados' },
    ])
    expect(duas.match(/- #12:/g)?.length).toBe(1)
    expect(duas.match(/gitorch:reavaliado:12/g)?.length).toBe(1)
  })
})

describe('sinalDeCruzamento', () => {
  it('cruza quando Related Files coincidem', () => {
    const { cruza } = sinalDeCruzamento({
      tarefaBody: '## Related Files\n\nsrc/a.ts',
      bloqueadorBody: '## Related Files\n\nsrc/a.ts',
      bloqueadorNumero: 5,
      bloqueadorTitulo: 'outra coisa',
    })
    expect(cruza).toBe(true)
  })

  it('sem cruzamento nenhum → cruza=false, mas o texto pede julgamento mesmo assim', () => {
    const { cruza, sinal } = sinalDeCruzamento({
      tarefaBody: '## Related Files\n\nsrc/a.ts\n\n## Goal\n\nfazer x',
      bloqueadorBody: '## Related Files\n\nsrc/b.ts',
      bloqueadorNumero: 5,
      bloqueadorTitulo: 'outra coisa',
    })
    expect(cruza).toBe(false)
    expect(sinal).toMatch(/decida com julgamento/)
  })
})

describe('runReavaliarBloqueios', () => {
  it('remove bloqueio sem dependência real: corpo some o número, comentário registrado', async () => {
    const issues: FakeIssue[] = [
      {
        number: 100,
        title: 'Task A',
        body: 'Goal\n\n## Goal\n\nfazer A\n\n## Related Files\n\nsrc/a.ts\n\nBlocked by #99',
        labels: ['gitorch:task'],
      },
      {
        number: 99,
        title: 'Task B',
        body: '## Goal\n\nfazer B\n\n## Related Files\n\nsrc/b.ts',
        labels: ['gitorch:task'],
        state: 'open',
      },
    ]
    const { impl, comments, patches } = fakeFetch(issues)
    const execute = execExpr({
      '#100': { decisao: 'remover', motivo: 'áreas e arquivos diferentes' },
    })

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })

    expect(result).toEqual({
      removidos: 1,
      mantidos: 0,
      interrompidoPorMotor: false,
      restamPendentes: false,
    })
    expect(patches).toHaveLength(1)
    expect(patches[0]!.body).not.toContain('#99')
    expect(comments).toHaveLength(1)
    expect(comments[0]!.body).toContain('não depende de #99')
    expect(comments[0]!.body).toContain('áreas e arquivos diferentes')
  })

  it('mantém e acrescenta o motivo quando há dependência real', async () => {
    const issues: FakeIssue[] = [
      {
        number: 200,
        title: 'Task C',
        body: '## Goal\n\nusa o arquivo criado em #99\n\nBlocked by #99',
        labels: ['gitorch:task'],
      },
      {
        number: 99,
        title: 'Task D',
        body: '## Goal\n\ncria o arquivo\n\n## Related Files\n\nsrc/shared.ts',
        labels: ['gitorch:task'],
        state: 'open',
      },
    ]
    const { impl, patches } = fakeFetch(issues)
    const execute = execExpr({
      '#200': { decisao: 'manter', motivo: 'usa o contrato de dados criado pela outra tarefa' },
    })

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })

    expect(result).toEqual({
      removidos: 0,
      mantidos: 1,
      interrompidoPorMotor: false,
      restamPendentes: false,
    })
    expect(patches[0]!.body).toContain('Blocked by #99')
    expect(patches[0]!.body).toContain('- #99: usa o contrato de dados criado pela outra tarefa')
  })

  it('não reavalia o mesmo par duas vezes (marcador de idempotência)', async () => {
    const issues: FakeIssue[] = [
      {
        number: 300,
        title: 'Task E',
        body: '## Goal\n\nx\n\nBlocked by #99\n- #99: usa o contrato\n<!-- gitorch:reavaliado:99 -->',
        labels: ['gitorch:task'],
      },
      {
        number: 99,
        title: 'Task F',
        body: '## Goal\n\ny',
        labels: ['gitorch:task'],
        state: 'open',
      },
    ]
    const { impl } = fakeFetch(issues)
    const execute = vi.fn(async () => {
      throw new Error('não deveria chamar o motor para um par já reavaliado')
    })

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result).toEqual({
      removidos: 0,
      mantidos: 0,
      interrompidoPorMotor: false,
      restamPendentes: false,
    })
  })

  it('sem cota (motor lança) não decide nada e para nesse par — fica para a próxima rodada', async () => {
    const issues: FakeIssue[] = [
      {
        number: 400,
        title: 'Task G',
        body: '## Goal\n\nx\n\nBlocked by #99',
        labels: ['gitorch:task'],
      },
      {
        number: 99,
        title: 'Task H',
        body: '## Goal\n\ny',
        labels: ['gitorch:task'],
        state: 'open',
      },
    ]
    const { impl, patches, comments } = fakeFetch(issues)
    const execute = vi.fn(async () => {
      throw new Error('sem cota em nenhum motor da cadeia')
    })

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
      onWarn: () => undefined,
    })

    expect(result).toEqual({
      removidos: 0,
      mantidos: 0,
      interrompidoPorMotor: true,
      restamPendentes: true,
    })
    expect(patches).toHaveLength(0)
    expect(comments).toHaveLength(0)
  })

  it('autonomia "só olhar" recusa a escrita e não quebra a rodada', async () => {
    const issues: FakeIssue[] = [
      {
        number: 500,
        title: 'Task I',
        body: '## Goal\n\nx\n\nBlocked by #99',
        labels: ['gitorch:task'],
      },
      {
        number: 99,
        title: 'Task J',
        body: '## Goal\n\ny',
        labels: ['gitorch:task'],
        state: 'open',
      },
    ]
    const { impl } = fakeFetch(issues)
    const fetchQueRecusaEscrita = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET')
        throw new Error('EscritaNaoAutorizadaError: nível "só olhar" não escreve')
      return impl(url, init)
    }) as typeof fetch
    const execute = execExpr({ '#500': { decisao: 'remover', motivo: 'áreas diferentes' } })
    const onWarn = vi.fn()

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: fetchQueRecusaEscrita,
      onWarn,
    })

    expect(result).toEqual({
      removidos: 0,
      mantidos: 0,
      interrompidoPorMotor: false,
      restamPendentes: true,
    })
    expect(onWarn).toHaveBeenCalled()
  })

  it('acorda o SM quando um bloqueio foi removido', async () => {
    const issues: FakeIssue[] = [
      {
        number: 600,
        title: 'Task K',
        body: '## Goal\n\nx\n\nBlocked by #99',
        labels: ['gitorch:task'],
      },
      {
        number: 99,
        title: 'Task L',
        body: '## Goal\n\ny',
        labels: ['gitorch:task'],
        state: 'open',
      },
    ]
    const { impl } = fakeFetch(issues)
    const execute = execExpr({ '#600': { decisao: 'remover', motivo: 'áreas diferentes' } })
    const acordar = vi.fn()
    const eventos: Array<{ type: string; createdAt: Date; payload: unknown }> = []
    const prisma = {
      event: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: { type: string; payload: unknown } }) => {
          eventos.push({ ...data, createdAt: new Date() })
          return {}
        }),
      },
    }

    const resultado = await rodarReavaliacaoDeProjetoSeForAHora({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
      prisma: prisma as never,
      projectId: 'proj-1',
      acordarSmPorVagaLiberada: acordar,
    })

    expect(resultado?.removidos).toBe(1)
    expect(acordar).toHaveBeenCalledWith('proj-1', expect.any(String))
    expect(eventos.some((e) => e.type === TIPO_EVENTO_ULTIMA_EXECUCAO)).toBe(true)
    expect(eventos.some((e) => e.type === 'audit')).toBe(true)
  })
})

describe('runReavaliarBloqueios — teto por rodada', () => {
  afterEach(() => {
    delete process.env[ENV_POR_RODADA_DE_REAVALIACAO]
  })

  it('20 pares independentes, teto 8: só os 8 mais antigos chamam o motor; sobra fica marcado', async () => {
    process.env[ENV_POR_RODADA_DE_REAVALIACAO] = '8'

    const issues: FakeIssue[] = []
    for (let i = 0; i < 20; i++) {
      issues.push({
        number: 1000 + i,
        title: `Task ${i}`,
        body: `## Goal\n\nfazer ${i}\n\nBlocked by #${5000 + i}`,
        labels: ['gitorch:task'],
      })
      issues.push({
        number: 5000 + i,
        title: `Blocker ${i}`,
        body: '## Goal\n\ny',
        labels: [],
        state: 'open',
      })
    }
    const { impl } = fakeFetch(issues)
    const execute = vi.fn(async (prompt: string) => {
      const m = prompt.match(/Task under review: #(\d+)/)
      if (!m) throw new Error(`prompt inesperado: ${prompt.slice(0, 200)}`)
      return JSON.stringify({ decisao: 'remover', motivo: `áreas diferentes, par ${m[1]}` })
    })

    const round1 = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })

    expect(execute).toHaveBeenCalledTimes(8)
    expect(round1.removidos).toBe(8)
    expect(round1.restamPendentes).toBe(true)
    // os 8 mais antigos (menor número) são os primeiros a serem chamados
    const numerosChamados1 = execute.mock.calls.map(([p]) =>
      Number(String(p).match(/Task under review: #(\d+)/)![1])
    )
    expect(new Set(numerosChamados1)).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => 1000 + i))
    )

    execute.mockClear()
    const round2 = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })
    expect(execute).toHaveBeenCalledTimes(8)
    expect(round2.restamPendentes).toBe(true)
    const numerosChamados2 = execute.mock.calls.map(([p]) =>
      Number(String(p).match(/Task under review: #(\d+)/)![1])
    )
    expect(new Set(numerosChamados2)).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => 1008 + i))
    )

    execute.mockClear()
    const round3 = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })
    expect(execute).toHaveBeenCalledTimes(4)
    expect(round3.restamPendentes).toBe(false)
  })
})

describe('runReavaliarBloqueios — releitura fresca antes de aplicar', () => {
  it('corpo muda entre a leitura inicial e a aplicação: PATCH preserva o texto extra', async () => {
    let corpoAtual = '## Goal\n\nx\n\nBlocked by #99'
    let jaReleu = false
    const patches: Array<{ body: string }> = []
    const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
        return json([
          { number: 700, title: 'Task M', body: corpoAtual, labels: [{ name: 'gitorch:task' }] },
        ])
      }
      if (/\/issues\/99$/.test(u)) {
        return json({ number: 99, state: 'open', title: 'Blocker', body: '## Goal\n\ny' })
      }
      if (/\/issues\/700\/comments$/.test(u)) {
        return json({})
      }
      if (/\/issues\/700$/.test(u)) {
        if (method === 'GET') {
          if (!jaReleu) {
            // Simula a edição concorrente que aconteceu ENTRE a listagem
            // inicial (usada para montar o prompt) e esta releitura logo
            // antes de aplicar a decisão do motor — o SM/PO editou o corpo
            // (a seção "Blocked by" continua por último, como este próprio
            // serviço sempre escreve).
            corpoAtual = corpoAtual.replace(
              '\n\nBlocked by #99',
              '\n\n## Notas do SM\n\nEditado enquanto o motor decidia.\n\nBlocked by #99'
            )
            jaReleu = true
          }
          return json({ number: 700, state: 'open', body: corpoAtual })
        }
        if (method === 'PATCH') {
          const body = (JSON.parse(String(init?.body)) as { body: string }).body
          patches.push({ body })
          corpoAtual = body
          return json({})
        }
      }
      return json({})
    }) as typeof fetch
    const execute = execExpr({
      '#700': { decisao: 'remover', motivo: 'áreas diferentes' },
    })

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })

    expect(result.removidos).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.body).toContain('## Notas do SM')
    expect(patches[0]!.body).not.toContain('Blocked by')
  })

  it('bloqueador já removido por outro entre a leitura e a aplicação: par pulado, sem PATCH', async () => {
    let corpoAtual = '## Goal\n\nx\n\nBlocked by #99'
    let jaReleu = false
    const patches: Array<{ body: string }> = []
    const comments: Array<{ body: string }> = []
    const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
        return json([
          { number: 800, title: 'Task N', body: corpoAtual, labels: [{ name: 'gitorch:task' }] },
        ])
      }
      if (/\/issues\/99$/.test(u)) {
        return json({ number: 99, state: 'open', title: 'Blocker', body: '## Goal\n\ny' })
      }
      if (/\/issues\/800\/comments$/.test(u)) {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body
        comments.push({ body })
        return json({})
      }
      if (/\/issues\/800$/.test(u)) {
        if (method === 'GET') {
          if (!jaReleu) {
            // Alguém (SM/PO, ou outra rodada) já resolveu #99 e tirou o
            // "Blocked by" inteiro antes desta releitura acontecer.
            corpoAtual = '## Goal\n\nx\n\n(já resolvido por outro caminho)'
            jaReleu = true
          }
          return json({ number: 800, state: 'open', body: corpoAtual })
        }
        if (method === 'PATCH') {
          const body = (JSON.parse(String(init?.body)) as { body: string }).body
          patches.push({ body })
          return json({})
        }
      }
      return json({})
    }) as typeof fetch
    const execute = execExpr({
      '#800': { decisao: 'remover', motivo: 'áreas diferentes' },
    })

    const result = await runReavaliarBloqueios({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
    })

    expect(result).toEqual({
      removidos: 0,
      mantidos: 0,
      interrompidoPorMotor: false,
      restamPendentes: false,
    })
    expect(patches).toHaveLength(0)
    expect(comments).toHaveLength(0)
  })
})

describe('rodarReavaliacaoDeProjetoSeForAHora — agenda não espera com pendente sobrando', () => {
  afterEach(() => {
    delete process.env[ENV_POR_RODADA_DE_REAVALIACAO]
  })

  it('teto deixou pendente: NÃO marca a rodada como concluída (próxima missão do PO roda de novo)', async () => {
    process.env[ENV_POR_RODADA_DE_REAVALIACAO] = '1'
    const issues: FakeIssue[] = [
      {
        number: 900,
        title: 'Task O',
        body: '## Goal\n\nx\n\nBlocked by #99',
        labels: ['gitorch:task'],
      },
      {
        number: 901,
        title: 'Task P',
        body: '## Goal\n\nx\n\nBlocked by #98',
        labels: ['gitorch:task'],
      },
      { number: 99, title: 'B1', body: '## Goal\n\ny', labels: [], state: 'open' },
      { number: 98, title: 'B2', body: '## Goal\n\ny', labels: [], state: 'open' },
    ]
    const { impl } = fakeFetch(issues)
    const execute = execExpr({
      '#900': { decisao: 'remover', motivo: 'x' },
      '#901': { decisao: 'remover', motivo: 'x' },
    })
    const eventos: Array<{ type: string }> = []
    const prisma = {
      event: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: { type: string } }) => {
          eventos.push({ type: data.type })
          return {}
        }),
      },
    }

    const resultado = await rodarReavaliacaoDeProjetoSeForAHora({
      repository: 'dono/repo',
      githubToken: 'tok',
      execute,
      fetchImpl: impl,
      prisma: prisma as never,
      projectId: 'proj-2',
    })

    expect(resultado?.restamPendentes).toBe(true)
    expect(eventos.some((e) => e.type === TIPO_EVENTO_ULTIMA_EXECUCAO)).toBe(false)

    // a próxima missão do PO chama de novo (a agenda não espera os 7 dias)
    const deveRodarDeNovo = await deveRodarReavaliacaoAgora({
      prisma: prisma as never,
      projectId: 'proj-2',
    })
    expect(deveRodarDeNovo).toBe(true)
  })
})

describe('deveRodarReavaliacaoAgora', () => {
  it('nunca rodou → true (primeira vez após o boot)', async () => {
    const prisma = { event: { findFirst: vi.fn(async () => null), create: vi.fn() } }
    const deve = await deveRodarReavaliacaoAgora({ prisma: prisma as never, projectId: 'p1' })
    expect(deve).toBe(true)
  })

  it('rodou há 1 dia (padrão 7 dias) → false', async () => {
    const umDiaAtras = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const prisma = {
      event: { findFirst: vi.fn(async () => ({ createdAt: umDiaAtras })), create: vi.fn() },
    }
    const deve = await deveRodarReavaliacaoAgora({ prisma: prisma as never, projectId: 'p1' })
    expect(deve).toBe(false)
  })

  it('rodou há 8 dias (padrão 7 dias) → true', async () => {
    const oitoDiasAtras = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const prisma = {
      event: { findFirst: vi.fn(async () => ({ createdAt: oitoDiasAtras })), create: vi.fn() },
    }
    const deve = await deveRodarReavaliacaoAgora({ prisma: prisma as never, projectId: 'p1' })
    expect(deve).toBe(true)
  })
})
