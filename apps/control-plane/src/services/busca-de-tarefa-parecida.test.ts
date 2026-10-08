import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RailsStepError } from './rails-runner.js'
import { ErroDoGitHub } from './erro-do-github.js'
import { limparFreiosDeCota, registrarFreioDeCota } from './freio-de-cota-do-github.js'
import {
  TETO_DE_PERGUNTAS_POR_MISSAO,
  TETO_DE_PRS_POR_MISSAO,
  buscarTarefaParecidaDosPrs,
  resumoDaBusca,
  type DepsDaBuscaDeTarefaParecida,
  type PrismaDaBuscaDeTarefa,
} from './busca-de-tarefa-parecida.js'

// Fakes em memória: o banco de verdade é coberto por
// test/ligacao-busca-de-tarefa.integration.test.ts. Aqui ficam as regras de
// escolha, os tetos e o que o sistema NÃO aceita do analista.

const REPO = 'acme/api'
const PROJETO = 'proj_1'

interface Ficha {
  numero: number
  origem: string | null
  issueNumber: number | null
  vinculoOrigem: string | null
  status: string
}

interface Pergunta {
  dedupKey: string
  status: string
}

function criarBanco(fichas: Array<Partial<Ficha> & { numero: number }>) {
  const linhas: Ficha[] = fichas.map((f) => ({
    origem: 'pessoa',
    issueNumber: null,
    vinculoOrigem: null,
    status: 'open',
    ...f,
  }))
  const eventos: Array<{ chave: string; texto: string }> = []
  const perguntas: Pergunta[] = []
  const gravacoes: Array<Record<string, unknown>> = []

  const prisma = {
    repoItem: {
      findMany: vi.fn(async () =>
        linhas
          .filter((l) => l.status === 'open' && l.issueNumber === null)
          .sort((a, b) => b.numero - a.numero)
          .map((l) => ({ numero: l.numero, origem: l.origem }))
      ),
      findUnique: vi.fn(async (args: { where: { projectId_tipo_numero: { numero: number } } }) => {
        const l = linhas.find((x) => x.numero === args.where.projectId_tipo_numero.numero)
        return l
          ? {
              id: `ri_${l.numero}`,
              projectId: PROJETO,
              tipo: 'pr',
              numero: l.numero,
              estado: { status: l.status },
              origem: l.origem,
              issueNumber: l.issueNumber,
              entendimento: null,
              vinculoOrigem: l.vinculoOrigem,
            }
          : null
      }),
      upsert: vi.fn(
        async (args: {
          where: { projectId_tipo_numero: { numero: number } }
          update: Record<string, unknown>
        }) => {
          gravacoes.push(args.update)
          const l = linhas.find((x) => x.numero === args.where.projectId_tipo_numero.numero)
          if (l) {
            if (typeof args.update['issueNumber'] === 'number') {
              l.issueNumber = args.update['issueNumber']
            }
            if (typeof args.update['vinculoOrigem'] === 'string') {
              l.vinculoOrigem = args.update['vinculoOrigem']
            }
          }
          return {}
        }
      ),
    },
    event: {
      findFirst: vi.fn(
        async (args: { where: { payload: { equals: string } } }) =>
          eventos.find((e) => e.chave === args.where.payload.equals) ?? null
      ),
      create: vi.fn(async (args: { data: { payload: { texto: string; chave: string } } }) => {
        eventos.push({ chave: args.data.payload.chave, texto: args.data.payload.texto })
        return {}
      }),
    },
    agentQuestion: {
      findFirst: vi.fn(
        async (args: { where: { dedupKey: string; status: { in: string[] } } }) =>
          perguntas.find(
            (p) => p.dedupKey === args.where.dedupKey && args.where.status.in.includes(p.status)
          ) ?? null
      ),
    },
  }
  return {
    prisma: prisma as unknown as PrismaDaBuscaDeTarefa,
    linhas,
    eventos,
    perguntas,
    gravacoes,
  }
}

interface PrDoGitHub {
  number: number
  title?: string
  state?: string
  head: { sha: string }
}

function criarGitHub(config: {
  prs: PrDoGitHub[]
  issues: Array<{ number: number; title: string }>
  arquivos?: unknown[]
  falhaNosArquivos?: Error
}) {
  const chamadas: string[] = []
  const ghGet = vi.fn(async (caminho: string): Promise<unknown> => {
    chamadas.push(caminho)
    if (caminho.startsWith(`/repos/${REPO}/pulls?state=open`)) return config.prs
    if (caminho.startsWith(`/repos/${REPO}/issues?state=open`)) return config.issues
    if (/\/pulls\/\d+\/files/.test(caminho)) {
      if (config.falhaNosArquivos) throw config.falhaNosArquivos
      return (
        config.arquivos ?? [
          { filename: 'src/wishlist.ts', status: 'modified', additions: 4, deletions: 1 },
        ]
      )
    }
    throw new Error(`rota não prevista no teste: ${caminho}`)
  })
  return { ghGet, chamadas }
}

function pr(numero: number, sha = `sha${numero}`): PrDoGitHub {
  return { number: numero, title: `PR ${numero}`, state: 'open', head: { sha } }
}

const ISSUES = [
  { number: 713, title: '/wishlist add responde confirmação mas não registra o pedido' },
  { number: 30, title: 'Outra tarefa' },
  { number: 47, title: 'Mais uma' },
]

function respostaDoAnalista(issueNumberEncontrado: number | null, justificativa = 'porque sim') {
  return JSON.stringify({ issueNumberEncontrado, justificativa })
}

function montar(
  banco: ReturnType<typeof criarBanco>,
  github: ReturnType<typeof criarGitHub>,
  extra: Partial<DepsDaBuscaDeTarefaParecida> = {}
) {
  const ask = vi.fn(async (_u: string, _p: string, input: { dedupKey?: string }) => {
    banco.perguntas.push({ dedupKey: input.dedupKey ?? '', status: 'open' })
    return { deduped: false }
  })
  const execute = vi.fn(async (_prompt: string) => respostaDoAnalista(null))
  const info = vi.fn()
  const onWarn = vi.fn()
  const deps: DepsDaBuscaDeTarefaParecida = {
    prisma: banco.prisma,
    projectId: PROJETO,
    repo: REPO,
    userId: 'user_1',
    runtimeConfig: null,
    contextBlocks: ['contexto do RA'],
    execute,
    ghGet: github.ghGet,
    agentQuestion: { ask },
    agora: () => new Date('2026-01-01T12:00:00Z'),
    info,
    onWarn,
    ...extra,
  }
  return { deps, ask, execute, info, onWarn }
}

beforeEach(() => limparFreiosDeCota())

describe('buscarTarefaParecidaDosPrs: escolha dos pull requests', () => {
  it('sem pull request candidato: nenhuma chamada ao GitHub nem ao motor', async () => {
    const banco = criarBanco([])
    const github = criarGitHub({ prs: [], issues: ISSUES })
    const { deps, execute } = montar(banco, github)

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(github.ghGet).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(r.analisados).toBe(0)
    expect(resumoDaBusca(r)).toBe('')
  })

  it('ignora dependabot e outro_bot, e a origem que a configuração manda não cuidar', async () => {
    const banco = criarBanco([
      { numero: 1, origem: 'dependabot' },
      { numero: 2, origem: 'outro_bot' },
      { numero: 3, origem: 'pessoa' },
      { numero: 4, origem: 'assistente' },
    ])
    const github = criarGitHub({ prs: [pr(1), pr(2), pr(3), pr(4)], issues: ISSUES })
    const { deps, execute } = montar(banco, github, {
      runtimeConfig: { cuidaPorOrigem: { pessoa: 'nao' } },
    })

    await buscarTarefaParecidaDosPrs(deps)

    // Só o #4 (assistente) passa: #1/#2 são bot e #3 é "pessoa: nao".
    expect(execute).toHaveBeenCalledTimes(1)
    expect(github.chamadas.filter((c) => c.includes('/files'))).toEqual([
      `/repos/${REPO}/pulls/4/files?per_page=100`,
    ])
  })

  it('PR que já foi fechado no GitHub (não está na lista de abertos) é ignorado', async () => {
    const banco = criarBanco([{ numero: 7 }, { numero: 8 }])
    const github = criarGitHub({ prs: [pr(8)], issues: ISSUES })
    const { deps, execute } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)

    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('buscarTarefaParecidaDosPrs: o que o sistema aceita do analista', () => {
  it('achou uma issue da lista: grava issue_number com vinculo_origem "codigo" e registra no painel', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590, 'abc123')], issues: ISSUES })
    const { deps, execute, ask } = montar(banco, github)
    execute.mockResolvedValue(respostaDoAnalista(713, 'o diff mexe no /wishlist add'))

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(r.vinculados).toEqual([{ pr: 590, issue: 713 }])
    expect(banco.gravacoes).toHaveLength(1)
    expect(banco.gravacoes[0]).toMatchObject({ issueNumber: 713, vinculoOrigem: 'codigo' })
    expect(banco.eventos.map((e) => e.chave)).toEqual([`vinculo-ra:${REPO}:590:abc123`])
    expect(banco.eventos[0]!.texto).toContain('#713')
    expect(banco.eventos[0]!.texto).toContain('confirm')
    expect(ask).not.toHaveBeenCalled()
  })

  it('issue FORA da lista de abertas: tratada como null (o sistema decide, o LLM só sugere) e cai na pergunta', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590)], issues: ISSUES })
    const { deps, execute, ask } = montar(banco, github)
    execute.mockResolvedValue(respostaDoAnalista(9999, 'inventei'))

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(r.vinculados).toEqual([])
    expect(banco.gravacoes).toEqual([])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('número que não é inteiro positivo (fracionário, zero, negativo) também é null', async () => {
    for (const ruim of [7.5, 0, -3]) {
      const banco = criarBanco([{ numero: 590 }])
      const github = criarGitHub({
        prs: [pr(590)],
        issues: [...ISSUES, { number: 7, title: 'sete' }],
      })
      const { deps, execute } = montar(banco, github)
      execute.mockResolvedValue(respostaDoAnalista(ruim))
      const r = await buscarTarefaParecidaDosPrs(deps)
      expect(r.vinculados).toEqual([])
      expect(banco.gravacoes).toEqual([])
    }
  })

  it('null do analista: registra a tentativa e pergunta ao dono', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590, 'h1')], issues: ISSUES })
    const { deps, ask } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)

    expect(banco.eventos.map((e) => e.chave)).toEqual([`vinculo-ra:${REPO}:590:h1`])
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toBe('user_1')
    expect(ask.mock.calls[0]![1]).toBe(PROJETO)
  })

  it('o prompt do analista leva a lista de issues abertas e o resumo dos arquivos do PR', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590)], issues: ISSUES })
    const { deps, execute } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)

    const prompt = execute.mock.calls[0]![0]
    expect(prompt).toContain('#713')
    expect(prompt).toContain('contexto do RA')
    expect(prompt).toContain('src/wishlist.ts')
  })

  it('motor devolveu formulário inválido (RailsStepError): conta como "não achou" e pergunta ao dono', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590)], issues: ISSUES })
    const { deps, execute, ask } = montar(banco, github)
    execute.mockRejectedValue(new RailsStepError('forma inválida', ['x'], 3))

    await buscarTarefaParecidaDosPrs(deps)

    expect(banco.eventos).toHaveLength(1)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('falha do motor (processo caiu, cota): para a rodada, não registra tentativa e não pergunta', async () => {
    const banco = criarBanco([{ numero: 590 }, { numero: 591 }])
    const github = criarGitHub({ prs: [pr(590), pr(591)], issues: ISSUES })
    const { deps, execute, ask, onWarn } = montar(banco, github)
    execute.mockRejectedValue(new Error('motor sem cota'))

    await buscarTarefaParecidaDosPrs(deps)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(banco.eventos).toEqual([])
    expect(ask).not.toHaveBeenCalled()
    expect(onWarn).toHaveBeenCalled()
  })

  it('vínculo gravado por outra via no meio do caminho (varredura do retrato) não é sobrescrito', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590)], issues: ISSUES })
    const { deps, execute } = montar(banco, github)
    execute.mockImplementation(async () => {
      const ficha = banco.linhas[0]!
      ficha.issueNumber = 30
      ficha.vinculoOrigem = 'formal'
      return respostaDoAnalista(713)
    })

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(r.vinculados).toEqual([])
    expect(banco.gravacoes).toEqual([])
    expect(banco.linhas[0]!.issueNumber).toBe(30)
  })
})

describe('buscarTarefaParecidaDosPrs: tetos e uma tentativa por cabeça', () => {
  it('no máximo 3 pull requests por missão', async () => {
    const numeros = [1, 2, 3, 4, 5]
    const banco = criarBanco(numeros.map((numero) => ({ numero })))
    const github = criarGitHub({ prs: numeros.map((n) => pr(n)), issues: ISSUES })
    const { deps, execute } = montar(banco, github)

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(TETO_DE_PRS_POR_MISSAO).toBe(3)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(r.analisados).toBe(3)
    expect(github.chamadas.filter((c) => c.includes('/files'))).toHaveLength(3)
  })

  it('uma tentativa por (PR, head): a segunda missão com o mesmo head não chama o motor de novo', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590, 'h1')], issues: ISSUES })
    const { deps, execute } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)
    await buscarTarefaParecidaDosPrs(deps)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('head novo (push depois) vale outra tentativa', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const primeiro = criarGitHub({ prs: [pr(590, 'h1')], issues: ISSUES })
    const segundo = criarGitHub({ prs: [pr(590, 'h2')], issues: ISSUES })
    const a = montar(banco, primeiro)
    const b = montar(banco, segundo, { execute: a.execute })

    await buscarTarefaParecidaDosPrs(a.deps)
    await buscarTarefaParecidaDosPrs(b.deps)

    expect(a.execute).toHaveBeenCalledTimes(2)
    expect(banco.eventos.map((e) => e.chave)).toEqual([
      `vinculo-ra:${REPO}:590:h1`,
      `vinculo-ra:${REPO}:590:h2`,
    ])
  })

  it('o teto não faz fome: os pull requests já tentados saem da fila e os de trás entram', async () => {
    const numeros = [5, 4, 3, 2, 1]
    const banco = criarBanco(numeros.map((numero) => ({ numero })))
    const github = criarGitHub({ prs: numeros.map((n) => pr(n)), issues: ISSUES })
    const { deps, execute } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)
    await buscarTarefaParecidaDosPrs(deps)

    expect(execute).toHaveBeenCalledTimes(5)
  })
})

describe('buscarTarefaParecidaDosPrs: freio de cota do GitHub', () => {
  it('dono em freio: pula tudo com UMA linha de log, sem GitHub e sem motor', async () => {
    const banco = criarBanco([{ numero: 590 }, { numero: 591 }])
    const github = criarGitHub({ prs: [pr(590), pr(591)], issues: ISSUES })
    const { deps, execute, info } = montar(banco, github)
    const agora = deps.agora!()
    registrarFreioDeCota(
      'acme',
      new ErroDoGitHub('limite', {
        status: 403,
        retryAfterSegundos: 120,
        limiteRestante: null,
        limiteResetaEmSegundos: null,
      }),
      agora
    )

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(github.ghGet).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(r.puladoPorFreio).toBe(true)
  })

  it('403 de cota no meio do caminho: para a rodada sem insistir', async () => {
    const banco = criarBanco([{ numero: 590 }, { numero: 591 }])
    const github = criarGitHub({
      prs: [pr(590), pr(591)],
      issues: ISSUES,
      falhaNosArquivos: new ErroDoGitHub('GitHub GET failed (403)', {
        status: 403,
        retryAfterSegundos: 60,
        limiteRestante: 0,
        limiteResetaEmSegundos: null,
      }),
    })
    const { deps, execute, onWarn } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)

    expect(execute).not.toHaveBeenCalled()
    expect(github.chamadas.filter((c) => c.includes('/files'))).toHaveLength(1)
    expect(onWarn).toHaveBeenCalled()
  })
})

describe('buscarTarefaParecidaDosPrs: pergunta ao dono', () => {
  it('no máximo 2 perguntas novas por missão; a terceira sai na missão seguinte, sem gastar motor', async () => {
    const numeros = [3, 2, 1]
    const banco = criarBanco(numeros.map((numero) => ({ numero })))
    const github = criarGitHub({ prs: numeros.map((n) => pr(n)), issues: ISSUES })
    const { deps, ask, execute } = montar(banco, github)

    const primeira = await buscarTarefaParecidaDosPrs(deps)
    expect(TETO_DE_PERGUNTAS_POR_MISSAO).toBe(2)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(primeira.perguntados).toHaveLength(2)

    const segunda = await buscarTarefaParecidaDosPrs(deps)
    expect(ask).toHaveBeenCalledTimes(3)
    expect(segunda.perguntados).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('pergunta ABERTA para o mesmo PR: não repete a cada missão', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590, 'h1')], issues: ISSUES })
    const { deps, ask } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)
    await buscarTarefaParecidaDosPrs(deps)
    // Mesmo com um head novo (outra tentativa do analista) a pergunta aberta vale.
    const novoHead = criarGitHub({ prs: [pr(590, 'h2')], issues: ISSUES })
    await buscarTarefaParecidaDosPrs(montar(banco, novoHead, { agentQuestion: { ask } }).deps)

    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('pergunta RESPONDIDA (inclusive "nenhuma destas") nunca é refeita', async () => {
    const banco = criarBanco([{ numero: 590 }])
    banco.perguntas.push({ dedupKey: `vinculo-da-tarefa:${REPO}:590`, status: 'answered' })
    const github = criarGitHub({ prs: [pr(590)], issues: ISSUES })
    const { deps, ask } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)

    expect(ask).not.toHaveBeenCalled()
  })

  it('sem dono do projeto (userId nulo) ou sem serviço de perguntas: não pergunta', async () => {
    const semDono = criarBanco([{ numero: 590 }])
    const a = montar(semDono, criarGitHub({ prs: [pr(590)], issues: ISSUES }), { userId: null })
    await buscarTarefaParecidaDosPrs(a.deps)
    expect(a.ask).not.toHaveBeenCalled()

    const semServico = criarBanco([{ numero: 590 }])
    const b = montar(semServico, criarGitHub({ prs: [pr(590)], issues: ISSUES }), {
      agentQuestion: null,
    })
    const r = await buscarTarefaParecidaDosPrs(b.deps)
    expect(r.perguntados).toEqual([])
  })

  it('formato: 2 candidatas + "nenhuma destas" + resposta livre, contexto vazio e título do PR', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({ prs: [pr(590)], issues: ISSUES })
    const { deps, ask } = montar(banco, github)

    await buscarTarefaParecidaDosPrs(deps)

    const input = ask.mock.calls[0]![2] as unknown as {
      text: string
      options: Array<{ value: string }>
      dedupKey: string
    }
    expect(input.dedupKey).toBe(`vinculo-da-tarefa:${REPO}:590`)
    expect(input.options.map((o) => o.value)).toHaveLength(4)
    expect(input.options.at(-1)!.value).toBe('__gitorch_free_text__')
    expect(input.options.at(-2)!.value).toBe('nenhuma-destas')
    expect(input.text).toContain('PR 590')
    // contextoExecutivoVazio: nada de ciclo nem de decisões inventadas.
    expect(input.text).not.toContain('ciclo')
  })

  it('candidatas: as issues que o analista citou na justificativa vêm primeiro; o resto, as mais recentes', async () => {
    const banco = criarBanco([{ numero: 590 }])
    const github = criarGitHub({
      prs: [pr(590)],
      issues: [
        { number: 900, title: 'recente' },
        { number: 47, title: 'citada' },
        { number: 10, title: 'antiga' },
      ],
    })
    const { deps, ask, execute } = montar(banco, github)
    execute.mockResolvedValue(respostaDoAnalista(null, 'lembra a #47, mas não fecha nada'))

    await buscarTarefaParecidaDosPrs(deps)

    const opcoes = (ask.mock.calls[0]![2] as unknown as { options: Array<{ value: string }> })
      .options
    expect(opcoes.slice(0, 2).map((o) => o.value)).toEqual([
      'vinculo-issue-47',
      'vinculo-issue-900',
    ])
  })

  it('erro ao perguntar não derruba a rodada nem conta no teto', async () => {
    const banco = criarBanco([{ numero: 2 }, { numero: 1 }])
    const github = criarGitHub({ prs: [pr(1), pr(2)], issues: ISSUES })
    const { deps, ask, onWarn } = montar(banco, github)
    ask.mockRejectedValueOnce(new Error('telegram fora'))

    const r = await buscarTarefaParecidaDosPrs(deps)

    expect(onWarn).toHaveBeenCalled()
    expect(ask).toHaveBeenCalledTimes(2)
    expect(r.perguntados).toHaveLength(1)
  })
})
