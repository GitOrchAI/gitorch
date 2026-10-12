import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  GRUPOS_DE_IRMAOS,
  decidirDependabotDoVigia,
  decidirDependabotExpresso,
  irmaoPendenteDe,
  pacoteDoTitulo,
} from './dependabot-expresso.js'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'
import { vigiarPrsOrfaos, type PrAberto, type VigiaDoPrDeps } from './vigia-do-pr.js'

const CI_VERDE = { check_runs: [{ status: 'completed', conclusion: 'success' }] }
const SEM_WORKFLOW_RODANDO = { workflow_runs: [{ status: 'completed', conclusion: 'success' }] }

interface Cenario {
  titulo?: string
  autor?: string
  ramo?: string
  base?: string
  mergeable?: boolean | null
  estado?: string
  /** O head que cada leitura do PR devolve, na ordem; a última se repete. */
  heads?: string[]
  /** Índice (0 = primeira) da leitura do PR que falha. */
  leituraDoPrFalha?: number
  checkRuns?: unknown
  workflows?: unknown
  abertos?: unknown
  listaDeAbertosFalha?: boolean
  putFalha?: Error
  padrao?: string
}

function github(c: Cenario = {}) {
  let leituras = 0
  const ghGet = vi.fn(async (caminho: string, _token?: string): Promise<unknown> => {
    if (caminho === '/repos/org/repo/pulls/42') {
      const i = leituras
      leituras += 1
      if (c.leituraDoPrFalha === i) throw new Error('GitHub fora do ar')
      const heads = c.heads ?? ['sha1']
      return {
        number: 42,
        state: c.estado ?? 'open',
        title: c.titulo ?? 'Bump lodash from 4.17.20 to 4.17.21',
        user: { login: c.autor ?? 'dependabot[bot]' },
        body: 'Bumps lodash.',
        head: { sha: heads[Math.min(i, heads.length - 1)], ref: c.ramo ?? 'dependabot/npm/lodash' },
        base: { ref: c.base ?? 'main' },
        mergeable: c.mergeable === undefined ? true : c.mergeable,
      }
    }
    if (caminho === '/repos/org/repo') return { default_branch: c.padrao ?? 'main' }
    if (caminho.startsWith('/repos/org/repo/pulls?state=open')) {
      if (c.listaDeAbertosFalha) throw new Error('lista indisponível')
      return c.abertos ?? []
    }
    if (caminho.includes('/check-runs')) return c.checkRuns ?? CI_VERDE
    if (caminho.startsWith('/repos/org/repo/actions/runs'))
      return c.workflows ?? SEM_WORKFLOW_RODANDO
    return null
  })
  const ghSend = vi.fn(
    async (_m: string, _c: string, _t: string, _b: unknown): Promise<unknown> => {
      if (c.putFalha) throw c.putFalha
      return {}
    }
  )
  return { ghGet, ghSend }
}

function prismaFalso(perguntaAberta = false) {
  return {
    agentQuestion: { findFirst: vi.fn().mockResolvedValue(perguntaAberta ? { id: 'q' } : null) },
    repoItem: { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient
}

function depsDoCore(c: Cenario = {}, over: Record<string, unknown> = {}) {
  const gh = github(c)
  const registrarNoPainel = vi.fn(async () => undefined)
  const base = {
    runtimeConfig: { cuidaPorOrigem: { dependabot: 'sim' } },
    agora: new Date('2026-10-12T12:00:00Z'),
    projeto: { id: 'proj-1', wingId: 'org/repo' },
    token: 'tok',
    numero: 42,
    verificacao: 'verde' as const,
    mergeable: true as boolean | null,
    paradoHaMs: 0,
    ghGet: gh.ghGet,
    ghSend: gh.ghSend,
    registrarNoPainel,
    prisma: prismaFalso(),
    onWarn: vi.fn(),
    ...over,
  }
  return { gh, registrarNoPainel, deps: base }
}

const puts = (ghSend: ReturnType<typeof github>['ghSend']) =>
  ghSend.mock.calls.filter((c) => c[0] === 'PUT')

describe('decidirMergeDoDependabot: irmão pendente', () => {
  it('irmão pendente informado: não mescla e diz o motivo', () => {
    const r = decidirMergeDoDependabot({
      politica: 'sim',
      verificacao: 'verde',
      mergeable: true,
      irmaoPendente: 'o PR #43 atualiza `@prisma/client`',
    })
    expect(r.mesclar).toBe(false)
    expect(r.motivo).toContain('irmão pendente')
    expect(r.motivo).toContain('#43')
  })
  it('sem irmão pendente: continua mesclando', () => {
    expect(
      decidirMergeDoDependabot({
        politica: 'sim',
        verificacao: 'verde',
        mergeable: true,
        irmaoPendente: null,
      }).mesclar
    ).toBe(true)
  })
})

describe('grupos de irmãos', () => {
  it('lista os grupos conhecidos num lugar só', () => {
    const nomes = GRUPOS_DE_IRMAOS.flatMap((g) => g.pacotes)
    expect(nomes).toEqual(
      expect.arrayContaining([
        'prisma',
        '@prisma/client',
        'github/codeql-action/init',
        'github/codeql-action/analyze',
      ])
    )
  })
  it('lê o pacote e as versões do título do Dependabot', () => {
    expect(pacoteDoTitulo('Bump @prisma/client from 5.1.0 to 5.2.0')).toEqual({
      pacote: '@prisma/client',
      de: '5.1.0',
      para: '5.2.0',
    })
    expect(
      pacoteDoTitulo('chore(deps): bump prisma from 5.1.0 to 5.2.0 in /apps/api')?.pacote
    ).toBe('prisma')
    expect(pacoteDoTitulo('Update github/codeql-action requirement from 3.1 to 3.2')?.para).toBe(
      '3.2'
    )
    expect(pacoteDoTitulo('Bump the npm group with 3 updates')).toBeNull()
  })
  it('só acusa irmão quando é OUTRO membro do mesmo grupo e é PR aberto do Dependabot', () => {
    const abertos = [
      { numero: 42, titulo: 'Bump prisma from 5.1.0 to 5.2.0', autor: 'dependabot[bot]' },
      { numero: 43, titulo: 'Bump @prisma/client from 5.1.0 to 5.2.0', autor: 'dependabot[bot]' },
      { numero: 44, titulo: 'Bump lodash from 1 to 2', autor: 'dependabot[bot]' },
      { numero: 45, titulo: 'Bump @prisma/client from 5.1.0 to 5.2.0', autor: 'alguem' },
    ]
    expect(
      irmaoPendenteDe({ numero: 42, titulo: 'Bump prisma from 5.1.0 to 5.2.0', abertos })
    ).toMatch(/#43/)
    expect(irmaoPendenteDe({ numero: 44, titulo: 'Bump lodash from 1 to 2', abertos })).toBeNull()
    expect(
      irmaoPendenteDe({
        numero: 42,
        titulo: 'Bump prisma from 5.1.0 to 5.2.0',
        abertos: abertos.filter((a) => a.numero !== 43),
      })
    ).toBeNull()
  })
})

describe('decidirDependabotExpresso: merge com as garantias do merge do dev', () => {
  it('tudo verde, mergeável, base certa: mescla com o sha VIVO e registra no painel', async () => {
    const { gh, registrarNoPainel, deps } = depsDoCore({ heads: ['sha1', 'sha1'] })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(true)
    expect(r.acao).toBe('ignorar')
    expect(puts(gh.ghSend)).toHaveLength(1)
    expect(puts(gh.ghSend)[0]?.[1]).toBe('/repos/org/repo/pulls/42/merge')
    expect(puts(gh.ghSend)[0]?.[3]).toMatchObject({ sha: 'sha1' })
    expect(registrarNoPainel).toHaveBeenCalledWith(
      'proj-1',
      expect.stringContaining('dependabot-merge:org/repo:42'),
      expect.stringContaining('Merge feito')
    )
  })

  it('head mudou entre a leitura e o merge: NÃO mescla, com motivo, e o PUT nem sai', async () => {
    const { gh, registrarNoPainel, deps } = depsDoCore({ heads: ['sha1', 'sha2'] })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('o código mudou')
    expect(r.motivo).toContain('sha1')
    expect(r.motivo).toContain('sha2')
    expect(registrarNoPainel).toHaveBeenCalledWith(
      'proj-1',
      expect.any(String),
      expect.stringContaining('sha2')
    )
  })

  it('falha ao ler a cabeça viva: NÃO mescla, com motivo', async () => {
    const { gh, deps } = depsDoCore({ leituraDoPrFalha: 1 })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('não deu para ler o commit atual')
  })

  it.each([
    ['vermelha', { check_runs: [{ status: 'completed', conclusion: 'failure' }] }],
    ['pendente', { check_runs: [{ status: 'in_progress', conclusion: null }] }],
    [
      'só job pulado (sem job real concluído)',
      { check_runs: [{ status: 'completed', conclusion: 'skipped' }] },
    ],
    ['sem verificação nenhuma', { check_runs: [] }],
  ])('a verificação relida na porta do merge está %s: NÃO mescla', async (_nome, checkRuns) => {
    // O chamador diz "verde" (leitura velha); a porta relê e desmente.
    const { gh, deps } = depsDoCore({ checkRuns })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toMatch(/verificação/)
  })

  it('workflow do mesmo commit ainda rodando: NÃO mescla', async () => {
    const { gh, deps } = depsDoCore({ workflows: { workflow_runs: [{ status: 'in_progress' }] } })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
  })

  it('verificação vermelha informada pelo chamador: NÃO mescla e nem chega à porta', async () => {
    const { gh, deps } = depsDoCore({}, { verificacao: 'vermelha' })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(r.motivo).toContain('vermelha')
    expect(puts(gh.ghSend)).toHaveLength(0)
  })

  it.each([[false], [null]])('não mergeável (%s): NÃO mescla', async (mergeable) => {
    const { gh, deps } = depsDoCore({}, { mergeable })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
  })

  it('base diferente da branch padrão: NÃO mescla', async () => {
    const { gh, deps } = depsDoCore({ base: 'release/2026' })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('release/2026')
  })

  it('autor que não é o Dependabot: NÃO mescla', async () => {
    const { gh, deps } = depsDoCore({ autor: 'alguem-de-carne-e-osso' })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('Dependabot')
  })

  it('PR do aplicador de segurança do GitOrch: NÃO mescla (guarda do 5B intacta)', async () => {
    const { gh, deps } = depsDoCore({ ramo: 'gitorch/seguranca/permissoes-ci-yml' })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('melhoria de segurança')
  })

  it('o PUT do merge falha: o motivo do GitHub fica no retorno e no painel', async () => {
    const { registrarNoPainel, deps } = depsDoCore({
      putFalha: new Error('Required status check "ci" is expected'),
    })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(r.motivo).toContain('Required status check "ci" is expected')
    expect(registrarNoPainel).toHaveBeenCalledWith(
      'proj-1',
      expect.any(String),
      expect.stringContaining('Required status check "ci" is expected')
    )
  })
})

describe('decidirDependabotExpresso: irmãos que sobem juntos', () => {
  const abertosComIrmao = [
    {
      number: 42,
      title: 'Bump prisma from 5.1.0 to 5.2.0',
      user: { login: 'dependabot[bot]' },
    },
    {
      number: 43,
      title: 'Bump @prisma/client from 5.1.0 to 5.2.0',
      user: { login: 'dependabot[bot]' },
    },
  ]

  it('o outro membro do grupo tem PR aberto: NÃO mescla sozinho, "irmão pendente"', async () => {
    const { gh, registrarNoPainel, deps } = depsDoCore({
      titulo: 'Bump prisma from 5.1.0 to 5.2.0',
      abertos: abertosComIrmao,
    })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('irmão pendente')
    expect(r.motivo).toContain('#43')
    expect(registrarNoPainel).toHaveBeenCalledWith(
      'proj-1',
      expect.any(String),
      expect.stringContaining('irmão pendente')
    )
  })

  it('codeql: init com analyze aberto também espera', async () => {
    const { gh, deps } = depsDoCore({
      titulo: 'Bump github/codeql-action/init from 3.1.0 to 3.2.0',
      abertos: [
        {
          number: 42,
          title: 'Bump github/codeql-action/init from 3.1.0 to 3.2.0',
          user: { login: 'dependabot[bot]' },
        },
        {
          number: 50,
          title: 'Bump github/codeql-action/analyze from 3.1.0 to 3.2.0',
          user: { login: 'dependabot[bot]' },
        },
      ],
    })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('irmão pendente')
  })

  it('o irmão já não está aberto (alinhado): mescla', async () => {
    const { gh, deps } = depsDoCore({
      titulo: 'Bump prisma from 5.1.0 to 5.2.0',
      abertos: [abertosComIrmao[0]],
    })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(true)
    expect(puts(gh.ghSend)).toHaveLength(1)
  })

  it('não deu para listar os PRs abertos: NÃO mescla um membro de grupo', async () => {
    const { gh, deps } = depsDoCore({
      titulo: 'Bump prisma from 5.1.0 to 5.2.0',
      listaDeAbertosFalha: true,
    })
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('irmão')
  })

  it('pacote fora de qualquer grupo não gasta a listagem', async () => {
    const { gh, deps } = depsDoCore({})
    await decidirDependabotExpresso(deps)
    expect(gh.ghGet.mock.calls.some((c) => c[0].includes('/pulls?state=open'))).toBe(false)
  })
})

describe('decidirDependabotExpresso: política do projeto', () => {
  it('"perguntar": gera a pergunta ao dono, sem mesclar', async () => {
    const ask = vi.fn(async () => ({}))
    const { gh, deps } = depsDoCore(
      {},
      {
        runtimeConfig: { cuidaPorOrigem: { dependabot: 'perguntar' } },
        pergunta: { userId: 'u1', agentQuestion: { ask } },
      }
    )
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]).toEqual([
      'u1',
      'proj-1',
      expect.objectContaining({ dedupKey: 'cuida-deste-pedido:org/repo:42' }),
    ])
  })

  it('"perguntar" com pergunta ainda aberta: não pergunta de novo', async () => {
    const ask = vi.fn(async () => ({}))
    const { deps } = depsDoCore(
      {},
      {
        runtimeConfig: { cuidaPorOrigem: { dependabot: 'perguntar' } },
        pergunta: { userId: 'u1', agentQuestion: { ask } },
        prisma: prismaFalso(true),
      }
    )
    await decidirDependabotExpresso(deps)
    expect(ask).not.toHaveBeenCalled()
  })

  it('"nao": ignora sem rede, sem pergunta e sem merge', async () => {
    const ask = vi.fn(async () => ({}))
    const { gh, registrarNoPainel, deps } = depsDoCore(
      {},
      {
        runtimeConfig: { cuidaPorOrigem: { dependabot: 'nao' } },
        pergunta: { userId: 'u1', agentQuestion: { ask } },
      }
    )
    const r = await decidirDependabotExpresso(deps)
    expect(r.mesclou).toBe(false)
    expect(gh.ghGet).not.toHaveBeenCalled()
    expect(gh.ghSend).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(registrarNoPainel).not.toHaveBeenCalled()
  })
})

describe('decidirDependabotDoVigia: lê o estado fresco (a listagem não enriquece o Dependabot)', () => {
  function depsDoVigia(c: Cenario = {}, over: Record<string, unknown> = {}) {
    const { deps, gh, registrarNoPainel } = depsDoCore(c, over)
    const { verificacao: _v, mergeable: _m, paradoHaMs: _p, ...resto } = deps
    return { deps: resto, gh, registrarNoPainel }
  }

  it('mergeable e verificação vêm do GitHub agora, não da listagem', async () => {
    const { gh, deps } = depsDoVigia({ heads: ['sha1'] })
    const r = await decidirDependabotDoVigia({ ...deps, numero: 42 })
    expect(r.mesclou).toBe(true)
    expect(puts(gh.ghSend)).toHaveLength(1)
  })

  it('CI vermelha no GitHub: NÃO mescla', async () => {
    const { gh, deps } = depsDoVigia({
      checkRuns: { check_runs: [{ status: 'completed', conclusion: 'failure' }] },
    })
    const r = await decidirDependabotDoVigia({ ...deps, numero: 42 })
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('vermelha')
  })

  it('GitHub não confirma mergeable ainda (null): NÃO mescla', async () => {
    const { gh, deps } = depsDoVigia({ mergeable: null })
    const r = await decidirDependabotDoVigia({ ...deps, numero: 42 })
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
  })

  it('falha ao ler o PR: NÃO mescla e diz por quê', async () => {
    const { gh, registrarNoPainel, deps } = depsDoVigia({ leituraDoPrFalha: 0 })
    const r = await decidirDependabotDoVigia({ ...deps, numero: 42 })
    expect(r.mesclou).toBe(false)
    expect(puts(gh.ghSend)).toHaveLength(0)
    expect(r.motivo).toContain('GitHub fora do ar')
    expect(registrarNoPainel).toHaveBeenCalled()
  })
})

describe('o vigia leva o PR do Dependabot à decisão expressa, e só a ela', () => {
  function pr(over: Partial<PrAberto> & { numero: number }): PrAberto {
    return {
      autor: 'dependabot[bot]',
      labels: ['dependencies'],
      corpo: 'Bumps x.',
      rascunho: false,
      branchDoPr: 'dependabot/npm/x',
      branchNoRepoDoProjeto: true,
      mergeable: null,
      verificacao: 'pendente',
      paradoHaMs: 0,
      ...over,
    }
  }
  const DIA = 24 * 60 * 60 * 1000
  const PR_DO_DEV: Partial<PrAberto> = {
    autor: 'google-labs-jules[bot]',
    labels: ['jules'],
    corpo: 'PR criado automaticamente pelo Jules ... https://jules.google.com/task/123',
    branchDoPr: 'fix-algo',
    paradoHaMs: 7 * DIA,
    mergeable: true,
    verificacao: 'verde',
  }

  async function rodar(
    prs: PrAberto[],
    over: Partial<VigiaDoPrDeps> = {}
  ): Promise<{ resumo: string; efeitos: string[] }> {
    const efeitos: string[] = []
    const resumo = await vigiarPrsOrfaos({
      listarPrsAbertos: async () => prs,
      prsComSessaoViva: new Set<number>(),
      issueDoPr: () => 10,
      issueAberta: async () => true,
      acoesAnteriores: async () => 0,
      tarefaJaDevolvidaAFila: async () => false,
      vagasLivres: 10,
      pedirJulgamento: async () => {
        efeitos.push('julgamento')
      },
      abrirSessaoDeConserto: async () => {
        efeitos.push('sessão')
        return true
      },
      fecharPr: async () => {
        efeitos.push('fechou')
        return true
      },
      avisarDono: async () => {
        efeitos.push('avisou')
        return true
      },
      registrarDecisao: async () => {
        efeitos.push('decisão')
      },
      ...over,
    })
    return { resumo, efeitos }
  }

  it('PR do Dependabot chega à decisão expressa com o PR cru', async () => {
    const decidirDependabot = vi.fn(async (_pr: PrAberto) => ({ mesclou: false, motivo: 'x' }))
    await rodar([pr({ numero: 403 })], { decidirDependabot })
    expect(decidirDependabot).toHaveBeenCalledTimes(1)
    expect(decidirDependabot.mock.calls[0]?.[0]).toMatchObject({ numero: 403 })
  })

  it('o vigia NUNCA retoma sessão nem fecha PR do Dependabot, mesmo se a decisão pedir', async () => {
    // A decisão expressa só devolve "mesclou ou não"; o vigia não tem caminho
    // de conserto para ela. Mesmo um PR parado há dias, com CI vermelha.
    const decidirDependabot = vi.fn(async () => ({ mesclou: false, motivo: 'CI vermelha' }))
    const decidirAcaoNoPrOrfao = vi.fn()
    const { efeitos, resumo } = await rodar(
      [pr({ numero: 403, paradoHaMs: 30 * DIA, mergeable: false, verificacao: 'vermelha' })],
      { decidirDependabot, decidirAcaoNoPrOrfao }
    )
    expect(efeitos).toEqual([])
    expect(decidirAcaoNoPrOrfao).not.toHaveBeenCalled()
    expect(resumo).toContain('1 do dependabot')
  })

  it('PR do dev assíncrono segue pelo caminho de sempre e PR de pessoa segue de fora', async () => {
    const decidirDependabot = vi.fn(async () => ({ mesclou: false, motivo: 'x' }))
    const decidirAcaoNoPrOrfao = vi.fn(async (_o: unknown) => ({
      acao: 'ignorar' as const,
      motivo: 'ok',
    }))
    await rodar(
      [
        pr({ numero: 7, ...PR_DO_DEV }),
        pr({ numero: 8, autor: 'pessoa', labels: [], corpo: 'Corrige texto.' }),
      ],
      { decidirDependabot, decidirAcaoNoPrOrfao }
    )
    expect(decidirDependabot).not.toHaveBeenCalled()
    expect(decidirAcaoNoPrOrfao).toHaveBeenCalledTimes(1)
    expect(decidirAcaoNoPrOrfao.mock.calls[0]?.[0]).toMatchObject({ numero: 7 })
  })

  it('PR de segurança do GitOrch com cara de Dependabot não chega à decisão expressa', async () => {
    const decidirDependabot = vi.fn(async () => ({ mesclou: true, motivo: 'x' }))
    await rodar([pr({ numero: 9, branchDoPr: 'gitorch/seguranca/permissoes-ci-yml' })], {
      decidirDependabot,
    })
    expect(decidirDependabot).not.toHaveBeenCalled()
  })

  it('sem a decisão expressa injetada, o comportamento antigo (só contar) é o mesmo', async () => {
    const { resumo, efeitos } = await rodar([pr({ numero: 403 }), pr({ numero: 404 })])
    expect(efeitos).toEqual([])
    expect(resumo).toContain('2 do dependabot')
  })

  it('a decisão expressa lança: o laço segue e a falha é contada', async () => {
    const avisos: string[] = []
    const decidirDependabot = vi
      .fn()
      .mockRejectedValueOnce(new Error('rede caiu'))
      .mockResolvedValueOnce({ mesclou: false, motivo: 'x' })
    const { resumo } = await rodar([pr({ numero: 403 }), pr({ numero: 404 })], {
      decidirDependabot,
      onWarn: (m) => avisos.push(m),
    })
    expect(decidirDependabot).toHaveBeenCalledTimes(2)
    expect(avisos.join('\n')).toContain('rede caiu')
    expect(resumo).toContain('1 falha')
  })

  it('respeita o teto de ações da passada: depois de mesclar o teto, adia', async () => {
    const decidirDependabot = vi.fn(async () => ({ mesclou: true, motivo: 'mesclou' }))
    const { resumo } = await rodar([pr({ numero: 1 }), pr({ numero: 2 }), pr({ numero: 3 })], {
      decidirDependabot,
      teto: 2,
    })
    expect(decidirDependabot).toHaveBeenCalledTimes(2)
    expect(resumo).toContain('além do teto')
  })
})
