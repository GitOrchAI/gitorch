import { describe, expect, it, vi } from 'vitest'
import type { PrismaDaFichaDoItem, RepoItemRecord } from './ficha-do-item.js'
import {
  RESPOSTA_FECHAR_A_TAREFA,
  RESPOSTA_SEGUIR_COM_A_TAREFA,
  coletarEvidenciaDaTarefa,
  decidirSuspeita,
  encerrarTarefaEntregue,
  dedupKeyDaSuspeita,
  gravarMemoriaDaSuspeita,
  lerDedupKeyDaSuspeita,
  lerMemoriaDaSuspeita,
  processarRespostaDaSuspeita,
  resolverSuspeita,
  textoDoRegistroDeFechamento,
  type DepsDaEvidencia,
  type DepsDaSuspeita,
  type EvidenciaDaTarefa,
  type MemoriaDaSuspeita,
} from './suspeita-de-tarefa-resolvida.js'

const CRIADA = '2026-01-10T10:00:00Z'
const ATUALIZADA = '2026-01-12T10:00:00Z'
const d = (iso: string) => new Date(iso)

const evidencia = (parcial: Partial<EvidenciaDaTarefa> = {}): EvidenciaDaTarefa => ({
  entregas: [],
  reabertaEm: [],
  trabalhoEmAndamento: false,
  ...parcial,
})

describe('decidirSuspeita: a regra de evidência', () => {
  it('PR mesclado depois da criação da issue: entregue', () => {
    const v = decidirSuspeita({
      issueCriadaEm: d(CRIADA),
      evidencia: evidencia({ entregas: [{ pullRequest: 7, mergedAt: d('2026-01-11T00:00:00Z') }] }),
    })
    expect(v).toMatchObject({ tipo: 'entregue', entrega: { pullRequest: 7 } })
  })

  it('sem nenhuma entrega: sem evidência', () => {
    expect(decidirSuspeita({ issueCriadaEm: d(CRIADA), evidencia: evidencia() })).toEqual({
      tipo: 'sem-entrega',
    })
  })

  it('PR mesclado ANTES de a issue existir não conta', () => {
    const v = decidirSuspeita({
      issueCriadaEm: d(CRIADA),
      evidencia: evidencia({ entregas: [{ pullRequest: 7, mergedAt: d('2026-01-01T00:00:00Z') }] }),
    })
    expect(v.tipo).toBe('sem-entrega')
  })

  it('issue reaberta depois do merge: ambíguo', () => {
    const v = decidirSuspeita({
      issueCriadaEm: d(CRIADA),
      evidencia: evidencia({
        entregas: [{ pullRequest: 7, mergedAt: d('2026-01-11T00:00:00Z') }],
        reabertaEm: [d('2026-01-11T12:00:00Z')],
      }),
    })
    expect(v).toMatchObject({ tipo: 'ambiguo' })
  })

  it('issue reaberta ANTES do merge: o merge posterior vale como evidência', () => {
    const v = decidirSuspeita({
      issueCriadaEm: d(CRIADA),
      evidencia: evidencia({
        entregas: [{ pullRequest: 7, mergedAt: d('2026-01-11T12:00:00Z') }],
        reabertaEm: [d('2026-01-11T00:00:00Z')],
      }),
    })
    expect(v.tipo).toBe('entregue')
  })

  it('outra entrega da mesma tarefa em andamento: sinal contraditório, ambíguo', () => {
    const v = decidirSuspeita({
      issueCriadaEm: d(CRIADA),
      evidencia: evidencia({
        entregas: [{ pullRequest: 7, mergedAt: d('2026-01-11T00:00:00Z') }],
        trabalhoEmAndamento: true,
      }),
    })
    expect(v.tipo).toBe('ambiguo')
  })
})

describe('coletarEvidenciaDaTarefa', () => {
  const base = (parcial: Partial<DepsDaEvidencia> = {}): DepsDaEvidencia => ({
    sessoesMescladas: async () => [],
    prsLigadosNaFicha: async () => [],
    lerPullRequest: async () => null,
    lerEventosDaIssue: async () => [],
    existeTrabalhoEmAndamento: async () => false,
    ...parcial,
  })

  it('PR da sessão do dev mesclado na branch padrão vira entrega, com a data do GitHub', async () => {
    const e = await coletarEvidenciaDaTarefa(
      base({
        sessoesMescladas: async () => [{ pullRequest: 7, mergedAt: d('2026-01-09T00:00:00Z') }],
        lerPullRequest: async () => ({
          mesclado: true,
          mergedAt: '2026-01-11T00:00:00Z',
          baseEhPadrao: true,
        }),
      })
    )
    expect(e.entregas).toEqual([{ pullRequest: 7, mergedAt: d('2026-01-11T00:00:00Z') }])
  })

  it('PR ligado pelo grafo de vínculos também conta', async () => {
    const e = await coletarEvidenciaDaTarefa(
      base({
        prsLigadosNaFicha: async () => [9],
        lerPullRequest: async () => ({
          mesclado: true,
          mergedAt: '2026-01-11T00:00:00Z',
          baseEhPadrao: true,
        }),
      })
    )
    expect(e.entregas.map((x) => x.pullRequest)).toEqual([9])
  })

  it('PR fechado sem mesclar, ou mesclado em branch que não é a padrão, não é entrega', async () => {
    const e = await coletarEvidenciaDaTarefa(
      base({
        prsLigadosNaFicha: async () => [1, 2],
        lerPullRequest: async (n) =>
          n === 1
            ? { mesclado: false, mergedAt: null, baseEhPadrao: true }
            : { mesclado: true, mergedAt: '2026-01-11T00:00:00Z', baseEhPadrao: false },
      })
    )
    expect(e.entregas).toEqual([])
  })

  it('reaberturas só são lidas quando há entrega (poupa chamada)', async () => {
    const eventos = vi.fn(async () => [])
    await coletarEvidenciaDaTarefa(base({ lerEventosDaIssue: eventos }))
    expect(eventos).not.toHaveBeenCalled()
  })

  it('lê as reaberturas da issue quando há entrega', async () => {
    const e = await coletarEvidenciaDaTarefa(
      base({
        prsLigadosNaFicha: async () => [9],
        lerPullRequest: async () => ({
          mesclado: true,
          mergedAt: '2026-01-11T00:00:00Z',
          baseEhPadrao: true,
        }),
        lerEventosDaIssue: async () => [
          { event: 'closed', created_at: '2026-01-11T01:00:00Z' },
          { event: 'reopened', created_at: '2026-01-12T01:00:00Z' },
        ],
      })
    )
    expect(e.reabertaEm).toEqual([d('2026-01-12T01:00:00Z')])
  })

  it('falha de leitura no GitHub propaga: não se decide às cegas', async () => {
    await expect(
      coletarEvidenciaDaTarefa(
        base({
          prsLigadosNaFicha: async () => [9],
          lerPullRequest: async () => {
            throw new Error('403')
          },
        })
      )
    ).rejects.toThrow('403')
  })
})

interface Cenario {
  deps: DepsDaSuspeita
  fechadas: Array<number | null>
  perguntas: Array<{
    text: string
    options: Array<{ label: string; value: string }>
    dedupKey: string
  }>
  painel: Array<{ chave: string; texto: string }>
  memoria: { atual: MemoriaDaSuspeita | null }
  coletas: { n: number }
  avisos: string[]
}

function cenario(args: {
  autonomia: string | null
  evidencia?: EvidenciaDaTarefa | Error
  memoria?: MemoriaDaSuspeita | null
  perguntaJaAberta?: boolean
  fecharFalha?: Error
}): Cenario {
  const fechadas: Cenario['fechadas'] = []
  const perguntas: Cenario['perguntas'] = []
  const painel: Cenario['painel'] = []
  const memoria = { atual: args.memoria ?? null }
  const coletas = { n: 0 }
  const avisos: string[] = []
  const deps: DepsDaSuspeita = {
    autonomia: args.autonomia,
    repositorio: 'org/repo',
    tarefa: {
      numero: 46,
      titulo: 'Registrar o comando de lista de desejos',
      criadaEm: CRIADA,
      atualizadaEm: ATUALIZADA,
    },
    motivoDoDiagnostico: 'o grafo aponta um commit alterando o arquivo',
    lerMemoria: async () => memoria.atual,
    gravarMemoria: async (m) => {
      memoria.atual = { ...m, avaliadaEm: 'agora' }
    },
    coletarEvidencia: async () => {
      coletas.n += 1
      const e = args.evidencia ?? evidencia()
      if (e instanceof Error) throw e
      return e
    },
    fecharTarefa: async (pr) => {
      if (args.fecharFalha) throw args.fecharFalha
      fechadas.push(pr)
    },
    perguntar: async (p) => {
      perguntas.push(p)
    },
    perguntaAberta: async () => args.perguntaJaAberta ?? false,
    registrarNoPainel: async (chave, texto) => {
      painel.push({ chave, texto })
    },
    aviso: (m) => avisos.push(m),
  }
  return { deps, fechadas, perguntas, painel, memoria, coletas, avisos }
}

const ENTREGUE = evidencia({ entregas: [{ pullRequest: 7, mergedAt: d('2026-01-11T00:00:00Z') }] })
const AMBIGUA = evidencia({
  entregas: [{ pullRequest: 7, mergedAt: d('2026-01-11T00:00:00Z') }],
  reabertaEm: [d('2026-01-11T12:00:00Z')],
})

describe('resolverSuspeita em cuidar', () => {
  it('com evidência: fecha com o registro, anota no painel como desfazer e lembra na ficha', async () => {
    const c = cenario({ autonomia: 'cuidar', evidencia: ENTREGUE })
    const r = await resolverSuspeita(c.deps)
    expect(r).toEqual({ desfecho: 'fechada', avaliou: true })
    expect(c.fechadas).toEqual([7])
    expect(c.painel).toHaveLength(1)
    expect(c.painel[0]!.texto).toContain('PR #7')
    expect(c.painel[0]!.texto).toContain('reabrir')
    expect(c.memoria.atual?.veredito).toBe('fechada')
    expect(c.perguntas).toEqual([])
  })

  it('o registro da issue diz o PR e como desfazer, sem pedir nada a ninguém', () => {
    const t = textoDoRegistroDeFechamento(7)
    expect(t).toBe('Entregue pelo PR #7. Para desfazer: reabrir esta issue.')
  })

  it('sem evidência: descarta a suspeita, devolve à fila, registra e NÃO reavalia em laço', async () => {
    const c = cenario({ autonomia: 'cuidar', evidencia: evidencia() })
    const r1 = await resolverSuspeita(c.deps)
    expect(r1).toEqual({ desfecho: 'descartada', avaliou: true })
    expect(c.fechadas).toEqual([])
    expect(c.painel[0]!.texto).toContain('suspeita descartada')
    expect(c.painel[0]!.texto).toContain('não há entrega mesclada ligada a esta tarefa')
    expect(c.memoria.atual).toMatchObject({ veredito: 'descartada', issueAtualizadaEm: ATUALIZADA })

    // Segunda passada, nada mudou na issue: vem da memória, sem ler o GitHub.
    const r2 = await resolverSuspeita(c.deps)
    expect(r2).toEqual({ desfecho: 'descartada', avaliou: false })
    expect(c.coletas.n).toBe(1)
    expect(c.painel).toHaveLength(1)
  })

  it('a issue mudou depois da avaliação: avalia de novo', async () => {
    const c = cenario({
      autonomia: 'cuidar',
      evidencia: evidencia(),
      memoria: {
        veredito: 'descartada',
        issueAtualizadaEm: '2026-01-01T00:00:00Z',
        avaliadaEm: 'x',
      },
    })
    const r = await resolverSuspeita(c.deps)
    expect(r.avaliou).toBe(true)
    expect(c.coletas.n).toBe(1)
  })

  it('ambíguo: faz UMA pergunta com o PR, o que mudou e opções, e segura só essa tarefa', async () => {
    const c = cenario({ autonomia: 'cuidar', evidencia: AMBIGUA })
    const r = await resolverSuspeita(c.deps)
    expect(r).toEqual({ desfecho: 'perguntada', avaliou: true })
    expect(c.fechadas).toEqual([])
    expect(c.perguntas).toHaveLength(1)
    const p = c.perguntas[0]!
    expect(p.text).toContain('#46')
    expect(p.text).toContain('PR #7')
    expect(p.text).toContain('reaberta depois')
    expect(p.options.map((o) => o.value)).toEqual(
      expect.arrayContaining([RESPOSTA_FECHAR_A_TAREFA, RESPOSTA_SEGUIR_COM_A_TAREFA])
    )
    expect(p.dedupKey).toBe(dedupKeyDaSuspeita('org/repo', 46, ATUALIZADA))

    // Mesma passada seguinte: não pergunta de novo.
    const r2 = await resolverSuspeita(c.deps)
    expect(r2).toEqual({ desfecho: 'perguntada', avaliou: false })
    expect(c.perguntas).toHaveLength(1)
  })

  it('pergunta já aberta no banco: não repete', async () => {
    const c = cenario({ autonomia: 'cuidar', evidencia: AMBIGUA, perguntaJaAberta: true })
    await resolverSuspeita(c.deps)
    expect(c.perguntas).toEqual([])
    expect(c.memoria.atual?.veredito).toBe('perguntada')
  })

  it('falha ao reunir a evidência: não decide, tenta na próxima passada', async () => {
    const c = cenario({ autonomia: 'cuidar', evidencia: new Error('GitHub 403') })
    const r = await resolverSuspeita(c.deps)
    expect(r.desfecho).toBe('aguardando')
    expect(c.memoria.atual).toBeNull()
    expect(c.avisos[0]).toContain('403')
  })

  it('a guarda recusa o fechamento: aguarda, sem registrar como fechada', async () => {
    const c = cenario({
      autonomia: 'cuidar',
      evidencia: ENTREGUE,
      fecharFalha: new Error('nao autorizado'),
    })
    const r = await resolverSuspeita(c.deps)
    expect(r.desfecho).toBe('aguardando')
    expect(c.painel).toEqual([])
    expect(c.memoria.atual).toBeNull()
  })
})

describe('resolverSuspeita fora de cuidar não escreve no GitHub', () => {
  it('sugerir: pergunta pelo painel e Telegram, mesmo com evidência', async () => {
    const c = cenario({ autonomia: 'sugerir', evidencia: ENTREGUE })
    const r = await resolverSuspeita(c.deps)
    expect(r.desfecho).toBe('perguntada')
    expect(c.fechadas).toEqual([])
    expect(c.perguntas).toHaveLength(1)
  })

  it('so_olhar: só registra no painel', async () => {
    const c = cenario({ autonomia: 'so_olhar', evidencia: ENTREGUE })
    const r = await resolverSuspeita(c.deps)
    expect(r.desfecho).toBe('registrada')
    expect(c.fechadas).toEqual([])
    expect(c.perguntas).toEqual([])
    expect(c.painel).toHaveLength(1)
  })

  it('autonomia ausente cai no nível mais restrito: nada é escrito', async () => {
    const c = cenario({ autonomia: null, evidencia: ENTREGUE })
    await resolverSuspeita(c.deps)
    expect(c.fechadas).toEqual([])
  })
})

describe('a chave da pergunta', () => {
  it('vai e volta', () => {
    const k = dedupKeyDaSuspeita('org/repo', 46, ATUALIZADA)
    expect(lerDedupKeyDaSuspeita(k)).toEqual({
      repositorio: 'org/repo',
      numeroDaTarefa: 46,
      atualizadaEmMs: Date.parse(ATUALIZADA),
    })
    expect(lerDedupKeyDaSuspeita('outra:coisa')).toBeNull()
  })
})

describe('a resposta do dono', () => {
  const key = dedupKeyDaSuspeita('org/repo', 46, ATUALIZADA)
  const opcoes = [{ value: RESPOSTA_FECHAR_A_TAREFA }, { value: RESPOSTA_SEGUIR_COM_A_TAREFA }]
  const montar = () => {
    const fechadas: number[] = []
    const memorias: Array<[number, string]> = []
    const painel: string[] = []
    const avisos: string[] = []
    return {
      fechadas,
      memorias,
      painel,
      avisos,
      deps: {
        fecharTarefa: async (n: number) => {
          fechadas.push(n)
        },
        gravarMemoria: async (n: number, m: { veredito: string }) => {
          memorias.push([n, m.veredito])
        },
        registrarNoPainel: async (_c: string, t: string) => {
          painel.push(t)
        },
        onWarn: (m: string) => avisos.push(m),
      },
    }
  }

  it('fechar: encerra a tarefa e registra', async () => {
    const m = montar()
    await processarRespostaDaSuspeita(
      { dedupKey: key, resposta: RESPOSTA_FECHAR_A_TAREFA, opcoes },
      m.deps
    )
    expect(m.fechadas).toEqual([46])
    expect(m.memorias).toEqual([[46, 'fechada']])
  })

  it('seguir: devolve a tarefa à fila sem escrever no GitHub', async () => {
    const m = montar()
    await processarRespostaDaSuspeita(
      { dedupKey: key, resposta: RESPOSTA_SEGUIR_COM_A_TAREFA, opcoes },
      m.deps
    )
    expect(m.fechadas).toEqual([])
    expect(m.memorias).toEqual([[46, 'descartada']])
  })

  it('texto livre: não vira decisão, não fecha nada, e a tarefa não fica presa', async () => {
    const m = montar()
    await processarRespostaDaSuspeita({ dedupKey: key, resposta: 'sei lá, vê aí', opcoes }, m.deps)
    expect(m.fechadas).toEqual([])
    expect(m.memorias).toEqual([[46, 'descartada']])
    expect(m.avisos).toHaveLength(1)
  })

  it('opção que não estava na pergunta não fecha nada', async () => {
    const m = montar()
    await processarRespostaDaSuspeita(
      { dedupKey: key, resposta: RESPOSTA_FECHAR_A_TAREFA, opcoes: [] },
      m.deps
    )
    expect(m.fechadas).toEqual([])
  })
})

describe('a memória na ficha da tarefa', () => {
  function prismaFake(): PrismaDaFichaDoItem {
    const linhas = new Map<string, Record<string, unknown>>()
    const k = (w: { projectId: string; tipo: string; numero: number }) =>
      `${w.projectId}:${w.tipo}:${w.numero}`
    return {
      repoItem: {
        upsert: vi.fn(async (a) => {
          const key = k(a.where.projectId_tipo_numero)
          const atual = linhas.get(key)
          const linha = atual ? { ...atual, ...a.update } : { id: 'x', ...a.create }
          linhas.set(key, linha)
          return linha
        }),
        findUnique: vi.fn(
          async (a) =>
            (linhas.get(k(a.where.projectId_tipo_numero)) ?? null) as RepoItemRecord | null
        ),
      },
    } as unknown as PrismaDaFichaDoItem
  }

  it('grava e lê, por projeto e tarefa (o mesmo número em outro projeto não se confunde)', async () => {
    const prisma = prismaFake()
    await gravarMemoriaDaSuspeita(prisma, 'p1', 46, {
      veredito: 'descartada',
      issueAtualizadaEm: ATUALIZADA,
    })
    expect(await lerMemoriaDaSuspeita(prisma, 'p1', 46)).toMatchObject({
      veredito: 'descartada',
      issueAtualizadaEm: ATUALIZADA,
    })
    expect(await lerMemoriaDaSuspeita(prisma, 'p2', 46)).toBeNull()
  })

  it('preserva o que já havia na conferência da ficha', async () => {
    const prisma = prismaFake()
    const ficha = await (prisma.repoItem.upsert as unknown as (a: unknown) => Promise<unknown>)({
      where: { projectId_tipo_numero: { projectId: 'p1', tipo: 'issue', numero: 46 } },
      create: {
        projectId: 'p1',
        tipo: 'issue',
        numero: 46,
        estado: { status: 'open' },
        conferencia: { peso: 5 },
      },
      update: {},
    })
    expect(ficha).toBeTruthy()
    await gravarMemoriaDaSuspeita(prisma, 'p1', 46, {
      veredito: 'perguntada',
      issueAtualizadaEm: ATUALIZADA,
    })
    const lida = await prisma.repoItem.findUnique({
      where: { projectId_tipo_numero: { projectId: 'p1', tipo: 'issue', numero: 46 } },
    })
    expect(lida?.conferencia).toMatchObject({ peso: 5 })
  })
})

describe('encerrarTarefaEntregue', () => {
  it('comenta o registro e depois fecha a tarefa, no repositório dela', async () => {
    const chamadas: Array<{ url: string; metodo: string; corpo: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push({
        url: String(url),
        metodo: init?.method ?? 'GET',
        corpo: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await encerrarTarefaEntregue({
      fetchImpl,
      token: 't',
      repositorio: 'org/repo',
      numero: 46,
      pullRequest: 7,
    })
    expect(chamadas.map((c) => [c.metodo, c.url])).toEqual([
      ['POST', 'https://api.github.com/repos/org/repo/issues/46/comments'],
      ['PATCH', 'https://api.github.com/repos/org/repo/issues/46'],
    ])
    expect(chamadas[0]!.corpo).toEqual({
      body: 'Entregue pelo PR #7. Para desfazer: reabrir esta issue.',
    })
    expect(chamadas[1]!.corpo).toEqual({ state: 'closed', state_reason: 'completed' })
  })

  it('se o GitHub recusa o comentário, não fecha e lança com o motivo', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"message":"Issues are disabled"}', { status: 410 })
    ) as unknown as typeof fetch
    await expect(
      encerrarTarefaEntregue({
        fetchImpl,
        token: 't',
        repositorio: 'org/repo',
        numero: 46,
        pullRequest: null,
      })
    ).rejects.toThrow(/410.*Issues are disabled/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
