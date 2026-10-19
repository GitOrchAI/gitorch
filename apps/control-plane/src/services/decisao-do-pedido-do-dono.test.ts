import { describe, expect, it, vi } from 'vitest'
import {
  decidirPedidoDoDono,
  montarPedidoDoDono,
  type DepsDoPedidoDoDono,
} from './decisao-do-pedido-do-dono.js'
import type { Prisma } from '@prisma/client'
import { prFoiAssumidoPeloVigia, type PrAberto } from './vigia-do-pr.js'
import { MARCA_DO_PARECER } from './parecer-do-qa.js'
import { ABERTURA_DO_AVISO_AO_PARTICIPANTE } from './assumir-pedido-do-dono.js'

const HORA = 60 * 60 * 1000
const AGORA = new Date('2026-03-10T12:00:00.000Z')
const haHoras = (h: number): number => h * HORA

const REPO = 'acme/api'
const HEAD = 'abc1234'

function pr(sobrepor: Partial<PrAberto> = {}): PrAberto {
  return {
    numero: 42,
    autor: 'dono',
    labels: [],
    corpo: null,
    branchDoPr: 'ajuste-do-robo',
    branchNoRepoDoProjeto: true,
    headSha: HEAD,
    rascunho: false,
    mergeable: true,
    verificacao: 'verde',
    paradoHaMs: haHoras(25),
    ...sobrepor,
  }
}

const PARECER =
  `${MARCA_DO_PARECER}\n<!-- gitorch:qa:tarefa:7 -->\nGitOrch QA verdict: REQUEST CHANGES.\n` +
  'Falta validar o telefone no cadastro.\n\n' +
  `${ABERTURA_DO_AVISO_AO_PARTICIPANTE} (o GitHub informa a relação).`

function reviews(extra: unknown[] = []): unknown[] {
  return [
    {
      body: PARECER,
      commit_id: HEAD,
      submitted_at: new Date(AGORA.getTime() - haHoras(26)).toISOString(),
      user: { login: 'gitorch-ai[bot]', type: 'Bot' },
    },
    ...extra,
  ]
}

function montar(
  sobrepor: Partial<DepsDoPedidoDoDono> & {
    reviewsDoPr?: unknown[]
    comentarios?: unknown[]
    comentariosDeCodigo?: unknown[]
  } = {}
) {
  const { reviewsDoPr, comentarios, comentariosDeCodigo, ...resto } = sobrepor
  const chamadas: string[] = []
  const ghGet = vi.fn(async (caminho: string) => {
    chamadas.push(caminho)
    if (caminho.includes('/reviews')) return reviewsDoPr ?? reviews()
    if (caminho.includes('/issues/42/comments')) return comentarios ?? []
    if (caminho.includes('/pulls/42/comments')) return comentariosDeCodigo ?? []
    return null
  })
  const registrarNoPainel = vi.fn(
    async (_projectId: string, _chave: string, _texto: string): Promise<void> => undefined
  )
  const deps: DepsDoPedidoDoDono = {
    agora: AGORA,
    projeto: { id: 'proj-1', wingId: REPO, autonomia: 'cuidar' },
    token: 't',
    pr: pr(),
    issueNumber: 7,
    acoesAnteriores: 0,
    podeAbrirSessao: true,
    ghGet,
    registrarNoPainel,
    prisma: {
      agentQuestion: { findFirst: vi.fn(async () => null) },
    } as unknown as DepsDoPedidoDoDono['prisma'],
    onWarn: vi.fn(),
    ...resto,
  }
  return { deps, ghGet, chamadas, registrarNoPainel }
}

describe('decidirPedidoDoDono', () => {
  it('cuidar, parecer pedindo mudanças há 25 h: retoma, com parecer e ramo do dono na instrução', async () => {
    const { deps } = montar()
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('retomar')
    if (r.acao !== 'retomar') return
    expect(r.issueNumber).toBe(7)
    expect(r.causa).toBe('qa-reprovou')
    expect(r.branchDoPr).toBe('ajuste-do-robo')
    expect(r.pedido).toContain('Falta validar o telefone no cadastro.')
    expect(r.pedido).toContain('#42')
    // o aviso ao autor e as marcas internas não vão para o dev
    expect(r.pedido).not.toContain(ABERTURA_DO_AVISO_AO_PARTICIPANTE)
    expect(r.pedido).not.toContain('gitorch:')
  })

  it('23 horas parado: não toca e registra UMA vez que aguarda quem abriu', async () => {
    const { deps, registrarNoPainel } = montar({
      pr: pr({ paradoHaMs: haHoras(23) }),
      reviewsDoPr: reviews().map((r) => ({
        ...(r as object),
        submitted_at: new Date(AGORA.getTime() - haHoras(23)).toISOString(),
      })),
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
    expect(registrarNoPainel).toHaveBeenCalledTimes(1)
    const [projectId, chave, texto] = registrarNoPainel.mock.calls[0]!
    expect(projectId).toBe('proj-1')
    expect(chave).toContain('acme/api')
    expect(chave).toContain('42')
    expect(chave).toContain(HEAD)
    expect(texto).toContain('aguardando quem abriu')
    expect(texto).toContain('assumo')
  })

  it('a chave do aviso de espera é a mesma a cada passada (o painel não repete)', async () => {
    const a = montar({ pr: pr({ paradoHaMs: haHoras(23) }) })
    const b = montar({ pr: pr({ paradoHaMs: haHoras(22) }) })
    await decidirPedidoDoDono(a.deps)
    await decidirPedidoDoDono(b.deps)
    expect(a.registrarNoPainel.mock.calls[0]?.[1]).toBe(b.registrarNoPainel.mock.calls[0]?.[1])
  })

  it('comentário de pessoa recente reinicia a espera, mesmo com commit antigo', async () => {
    const { deps } = montar({
      comentarios: [
        {
          created_at: new Date(AGORA.getTime() - haHoras(2)).toISOString(),
          user: { login: 'dono', type: 'User' },
          body: 'estou vendo isso',
        },
      ],
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
  })

  it('comentário do próprio produto não reinicia a espera', async () => {
    const { deps } = montar({
      comentarios: [
        {
          created_at: new Date(AGORA.getTime() - haHoras(1)).toISOString(),
          user: { login: 'gitorch-ai[bot]', type: 'Bot' },
          body: '<!-- gitorch:pr-substituido:9 --> aviso',
        },
      ],
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('retomar')
  })

  it('rótulo de não mexer: não toca nem lê o GitHub à toa', async () => {
    const { deps, chamadas } = montar({ pr: pr({ labels: ['gitorch:nao-mexer'] }) })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
    expect(chamadas).toHaveLength(0)
  })

  it('so_olhar: nada', async () => {
    const { deps, chamadas } = montar({
      projeto: { id: 'proj-1', wingId: REPO, autonomia: 'so_olhar' },
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
    expect(chamadas).toHaveLength(0)
  })

  it('sugerir: não assume; faz a pergunta "cuido deste pedido?" que já existe', async () => {
    const ask = vi.fn(async () => undefined)
    const { deps } = montar({
      projeto: { id: 'proj-1', wingId: REPO, autonomia: 'sugerir' },
      pergunta: { userId: 'u1', agentQuestion: { ask } },
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
    expect(ask).toHaveBeenCalledTimes(1)
    const entrada = (ask.mock.calls[0] as unknown as [string, string, { dedupKey?: string }])[2]
    expect(entrada.dedupKey).toBe('cuida-deste-pedido:acme/api:42')
  })

  it('sugerir: pergunta já aberta não gera outra', async () => {
    const ask = vi.fn(async () => undefined)
    const { deps } = montar({
      projeto: { id: 'proj-1', wingId: REPO, autonomia: 'sugerir' },
      pergunta: { userId: 'u1', agentQuestion: { ask } },
      prisma: {
        agentQuestion: { findFirst: vi.fn(async () => ({ id: 'q' })) },
      } as unknown as DepsDoPedidoDoDono['prisma'],
    })
    await decidirPedidoDoDono(deps)
    expect(ask).not.toHaveBeenCalled()
  })

  it('sem tarefa de origem: não consegue assumir e diz isso uma vez, sem pedir nada ao dono', async () => {
    const { deps, registrarNoPainel } = montar({ issueNumber: null })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
    expect(registrarNoPainel).toHaveBeenCalledTimes(1)
    expect(String(registrarNoPainel.mock.calls[0]?.[2])).toContain('tarefa')
  })

  it('rascunho não é tocado', async () => {
    const { deps, chamadas } = montar({ pr: pr({ rascunho: true }) })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
    expect(chamadas).toHaveLength(0)
  })

  it('o GitHub ainda calculando a mesclagem: espera, sem ler mais nada', async () => {
    const { deps, chamadas } = montar({ pr: pr({ mergeable: null }) })
    expect((await decidirPedidoDoDono(deps)).acao).toBe('ignorar')
    expect(chamadas).toHaveLength(0)
  })

  // Verificação "pendente" num PR parado há mais de um dia é verificação que
  // nunca respondeu, não verificação rodando: ela não é motivo, mas também não
  // trava o conflito nem o parecer.
  it('verificação pendente sozinha não é motivo', async () => {
    const { deps } = montar({ pr: pr({ verificacao: 'pendente' }), reviewsDoPr: [] })
    expect((await decidirPedidoDoDono(deps)).acao).toBe('ignorar')
  })

  it('verificação pendente não impede de assumir um conflito', async () => {
    const { deps } = montar({
      pr: pr({ verificacao: 'pendente', mergeable: false }),
      reviewsDoPr: [],
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('retomar')
    if (r.acao === 'retomar') expect(r.causa).toBe('conflito')
  })

  it('parecer de OUTRO commit não vale como motivo', async () => {
    const { deps } = montar({
      reviewsDoPr: reviews().map((r) => ({ ...(r as object), commit_id: 'outro' })),
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
  })

  it('verificação vermelha sem parecer: retoma pedindo para consertar a verificação', async () => {
    const { deps } = montar({ pr: pr({ verificacao: 'vermelha' }), reviewsDoPr: [] })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('retomar')
    if (r.acao !== 'retomar') return
    expect(r.causa).toBe('ci-vermelha')
    expect(r.pedido).toContain('verificação automática')
  })

  it('conflito: retoma pedindo para resolver o conflito', async () => {
    const { deps } = montar({ pr: pr({ mergeable: false }), reviewsDoPr: [] })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('retomar')
    if (r.acao !== 'retomar') return
    expect(r.causa).toBe('conflito')
    expect(r.pedido).toContain('conflito')
  })

  it('PR em fork (sem ramo no repositório): não retoma', async () => {
    const { deps } = montar({ pr: pr({ branchNoRepoDoProjeto: false }) })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
  })

  it('sem vaga na conta do dev: espera a próxima passada', async () => {
    const { deps } = montar({ podeAbrirSessao: false })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
  })

  it('teto: já houve uma retomada neste PR, não assume de novo', async () => {
    const { deps } = montar({ acoesAnteriores: 1 })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
  })

  it('o GitHub falhando na leitura nunca vira ação', async () => {
    const { deps } = montar()
    deps.ghGet = vi.fn(async () => {
      throw new Error('fora do ar')
    })
    const r = await decidirPedidoDoDono(deps)
    expect(r.acao).toBe('ignorar')
  })
})

describe('montarPedidoDoDono', () => {
  it('junta o parecer limpo, a verificação e o conflito, e cita o ramo do dono', () => {
    const texto = montarPedidoDoDono({
      numeroDoPr: 42,
      ramoDoPr: 'ajuste-do-robo',
      parecer: PARECER,
      verificacaoVermelha: true,
      conflito: true,
    })
    expect(texto).toContain('Falta validar o telefone no cadastro.')
    expect(texto).toContain('verificação automática')
    expect(texto).toContain('conflito')
    expect(texto).toContain('ajuste-do-robo')
    expect(texto).toContain('contra a `main`')
  })
})

describe('prFoiAssumidoPeloVigia', () => {
  interface Evento {
    projectId: string
    createdAt: Date
    payload: { vigiaDoPr: { numeroDoPr: number; acao: string } }
  }
  function banco(eventos: Evento[]) {
    const bate = (e: Evento, where: Prisma.EventWhereInput): boolean => {
      if (where.projectId !== undefined && where.projectId !== e.projectId) return false
      const criado = where.createdAt as { gte?: Date } | undefined
      if (criado?.gte && e.createdAt < criado.gte) return false
      const payload = where.payload as { path: string[]; equals: unknown } | undefined
      if (payload) {
        const valor =
          payload.path[1] === 'acao' ? e.payload.vigiaDoPr.acao : e.payload.vigiaDoPr.numeroDoPr
        if (valor !== payload.equals) return false
      }
      const and = where.AND as Prisma.EventWhereInput[] | undefined
      return !and || and.every((f) => bate(e, f))
    }
    return {
      event: {
        count: async ({ where }: { where: Prisma.EventWhereInput }) =>
          eventos.filter((e) => bate(e, where)).length,
      },
    }
  }
  const evento = (numeroDoPr: number, acao: string): Evento => ({
    projectId: 'p1',
    createdAt: new Date('2026-10-10T00:00:00Z'),
    payload: { vigiaDoPr: { numeroDoPr, acao } },
  })

  it('só uma retomada do vigia neste PR prova que o produto o assumiu', async () => {
    const db = banco([evento(42, 'retomar'), evento(43, 'escalar')])
    expect(await prFoiAssumidoPeloVigia(db, { projectId: 'p1', numeroDoPr: 42 })).toBe(true)
    expect(await prFoiAssumidoPeloVigia(db, { projectId: 'p1', numeroDoPr: 43 })).toBe(false)
    expect(await prFoiAssumidoPeloVigia(db, { projectId: 'p1', numeroDoPr: 99 })).toBe(false)
    expect(await prFoiAssumidoPeloVigia(db, { projectId: 'outro', numeroDoPr: 42 })).toBe(false)
  })
})
