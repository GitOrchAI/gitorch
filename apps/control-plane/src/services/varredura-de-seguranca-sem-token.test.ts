import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { varrerSegurancaDosProjetos } from './varredura-de-seguranca.js'
import { limparFreiosDeCota } from './freio-de-cota-do-github.js'
import {
  criarGitHubFalso,
  WORKFLOW_FIXADO,
  WORKFLOW_POR_TAG,
  type RepositorioFalso,
} from '../test/github-de-seguranca-fake.js'

// Tudo que a etapa grava (fichas, eventos do painel) ou escreve em log
// (info, aviso) não pode carregar uma credencial, nem no caminho feliz nem no
// de erro. As credenciais aqui são sentinelas reconhecíveis; o controle
// positivo prova que elas saíram de fato nas chamadas ao GitHub, senão a busca
// por elas não provaria nada.

const TOKEN_DO_CLIENTE = 'sentinela-cliente-7f3a9c1e'
const TOKEN_DO_APP = 'sentinela-app-b2d84e60'
const AGORA = new Date('2026-10-08T12:00:00Z')
const REPO = 'acme/api'

const REPOSITORIO: RepositorioFalso = {
  protecao: 'checks-sem-revisao',
  protecaoExigeToken: TOKEN_DO_APP,
  permissaoDoToken: 'write',
  arquivos: {
    '.github/CODEOWNERS': '* @acme',
    '.github/workflows/ci.yml': WORKFLOW_FIXADO,
    '.github/workflows/cd.yml': WORKFLOW_POR_TAG,
  },
  sbom: [{ name: 'copyleft', licenca: 'AGPL-3.0-only' }],
}

function montar(opcoes: { falharAoGravar?: boolean } = {}) {
  const gravado: unknown[] = []
  const eventos: unknown[] = []
  const prisma = {
    repoItem: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (args: unknown) => {
        if (opcoes.falharAoGravar) throw new Error('banco recusou a gravação')
        gravado.push(args)
        return {}
      }),
    },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: unknown) => {
        eventos.push(args)
        return {}
      }),
    },
  } as unknown as Pick<PrismaClient, 'repoItem' | 'event'>
  const logs: string[] = []
  return { prisma, gravado, eventos, logs }
}

describe('varrerSegurancaDosProjetos: nenhuma credencial vaza', () => {
  beforeEach(() => limparFreiosDeCota())

  async function passada(
    repositorio: RepositorioFalso,
    opcoes: {
      falharAoGravar?: boolean
      fetchQueFalha?: boolean
    } = {}
  ) {
    const github = criarGitHubFalso({ [REPO]: repositorio })
    const enviados: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      enviados.push(new Headers(init?.headers).get('authorization') ?? '')
      if (opcoes.fetchQueFalha) throw new Error('rede caiu')
      return github.fetchFalso(input, init)
    }) as typeof fetch
    const { prisma, gravado, eventos, logs } = montar(opcoes)
    const resumo = await varrerSegurancaDosProjetos({
      prisma,
      projetos: [{ id: 'proj_1', wingId: REPO, runtimeConfig: null }],
      agora: AGORA,
      credenciais: async () => [
        { origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE },
        { origem: 'App do produto', token: TOKEN_DO_APP },
      ],
      fetchImpl,
      falhasRecentes: new Map(),
      onInfo: (m) => logs.push(m),
      onWarn: (m) => logs.push(m),
    })
    const tudo = JSON.stringify({ gravado, eventos, logs, resumo })
    return { tudo, enviados, gravado, eventos, logs, resumo }
  }

  it('caminho feliz: fichas, eventos e logs sem token, e as duas credenciais foram usadas', async () => {
    const { tudo, enviados, gravado, eventos, resumo } = await passada(REPOSITORIO)

    expect(resumo.resultado).toBe('medido')
    expect(gravado).toHaveLength(2)
    expect(eventos.length).toBeGreaterThan(0)
    expect(enviados).toContain(`Bearer ${TOKEN_DO_CLIENTE}`)
    expect(enviados).toContain(`Bearer ${TOKEN_DO_APP}`)
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
  })

  it('SBOM fora do ar (conformidade "não verificado"): o motivo gravado não carrega token', async () => {
    const { tudo, gravado } = await passada({ ...REPOSITORIO, sbom: null })

    expect(JSON.stringify(gravado)).toContain('nao-verificado')
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
  })

  it('caminho de erro: leitura do GitHub falha, o aviso não carrega token', async () => {
    const { tudo, enviados, logs, resumo } = await passada(REPOSITORIO, { fetchQueFalha: true })

    expect(resumo.resultado).not.toBe('medido')
    expect(logs.length).toBeGreaterThan(0)
    expect(enviados).toContain(`Bearer ${TOKEN_DO_CLIENTE}`)
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
  })

  it('caminho de erro: a gravação falha, o aviso não carrega token', async () => {
    const { tudo, logs, resumo } = await passada(REPOSITORIO, { falharAoGravar: true })

    expect(resumo.resultado).toBe('falhou')
    expect(logs.some((m) => m.includes('banco recusou a gravação'))).toBe(true)
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
  })

  it('limite de taxa do GitHub (403): o aviso e o freio não carregam token', async () => {
    const { tudo, enviados } = await passada({ ...REPOSITORIO, limiteDeTaxa: true })

    expect(enviados).toContain(`Bearer ${TOKEN_DO_CLIENTE}`)
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
  })
})

// O valor lançado pode não ser um `Error` (`throw 'texto'`, `throw undefined`):
// a passada tem que registrar a falha e abrir o recuo de qualquer jeito, e o
// aviso externo não pode levar a credencial que a mensagem citar.
describe('varrerSegurancaDosProjetos: erro inesperado na passada', () => {
  beforeEach(() => limparFreiosDeCota())

  const VALORES_LANCADOS: ReadonlyArray<readonly [string, unknown]> = [
    ['texto', 'banco caiu'],
    ['objeto sem message', { codigo: 'E1' }],
    ['undefined', undefined],
    ['null', null],
    ['número', 42],
    ['símbolo', Symbol('s')],
    ['objeto sem protótipo', Object.create(null)],
  ]

  async function passadaQueLanca(lancado: () => unknown) {
    const github = criarGitHubFalso({ [REPO]: REPOSITORIO })
    const { prisma, gravado, eventos, logs } = montar()
    const falhasRecentes = new Map<string, number>()
    const upsert = prisma.repoItem.upsert as unknown as ReturnType<typeof vi.fn>
    upsert.mockImplementation(async () => {
      throw lancado()
    })
    const resumo = await varrerSegurancaDosProjetos({
      prisma,
      projetos: [{ id: 'proj_1', wingId: REPO, runtimeConfig: null }],
      agora: AGORA,
      credenciais: async () => [
        { origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE },
        { origem: 'App do produto', token: TOKEN_DO_APP },
      ],
      fetchImpl: github.fetchFalso,
      falhasRecentes,
      onInfo: (m) => logs.push(m),
      onWarn: (m) => logs.push(m),
    })
    return { resumo, falhasRecentes, logs, gravado, eventos }
  }

  it.each(VALORES_LANCADOS)(
    'lançar %s: a passada registra a falha, aplica o recuo e não propaga',
    async (_nome, valor) => {
      const { resumo, falhasRecentes, logs } = await passadaQueLanca(() => valor)

      expect(resumo.resultado).toBe('falhou')
      expect(falhasRecentes.get('proj_1')).toBe(AGORA.getTime())
      expect(logs.some((m) => m.includes('falhou'))).toBe(true)
    }
  )

  it('o recuo vale na passada seguinte: o projeto que falhou fica de lado', async () => {
    const github = criarGitHubFalso({ [REPO]: REPOSITORIO })
    const { prisma, logs } = montar({ falharAoGravar: true })
    const falhasRecentes = new Map<string, number>()
    const deps = {
      prisma,
      projetos: [{ id: 'proj_1', wingId: REPO, runtimeConfig: null }],
      credenciais: async () => [{ origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE }],
      fetchImpl: github.fetchFalso,
      falhasRecentes,
      onWarn: (m: string) => logs.push(m),
    }
    const primeira = await varrerSegurancaDosProjetos({ ...deps, agora: AGORA })
    const logo = new Date(AGORA.getTime() + 60_000)
    const segunda = await varrerSegurancaDosProjetos({ ...deps, agora: logo })

    expect(primeira.resultado).toBe('falhou')
    expect(segunda.resultado).toBe('nada-a-fazer')
  })

  it('o aviso que lança não escapa da passada, e o recuo já estava gravado quando ele foi chamado', async () => {
    const github = criarGitHubFalso({ [REPO]: REPOSITORIO })
    const { prisma } = montar({ falharAoGravar: true })
    const falhasRecentes = new Map<string, number>()
    const recuoNoMomentoDoAviso: boolean[] = []

    const resumo = await varrerSegurancaDosProjetos({
      prisma,
      projetos: [{ id: 'proj_1', wingId: REPO, runtimeConfig: null }],
      agora: AGORA,
      credenciais: async () => [{ origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE }],
      fetchImpl: github.fetchFalso,
      falhasRecentes,
      onWarn: (m) => {
        if (m.includes('falhou')) recuoNoMomentoDoAviso.push(falhasRecentes.has('proj_1'))
        throw new Error('o log quebrou')
      },
    })

    // controle positivo: o aviso da falha foi chamado (e lançou) antes de a passada devolver
    expect(recuoNoMomentoDoAviso).toEqual([true])
    expect(resumo.resultado).toBe('falhou')
    expect(falhasRecentes.get('proj_1')).toBe(AGORA.getTime())
  })

  it('erro com a credencial na mensagem: o aviso, a ficha e o painel saem sem o token', async () => {
    const { resumo, logs, gravado, eventos } = await passadaQueLanca(
      () => new Error(`conexão recusada com Authorization: Bearer ${TOKEN_DO_CLIENTE} no cabeçalho`)
    )

    expect(resumo.resultado).toBe('falhou')
    // controle positivo: o aviso saiu, com o resto da mensagem
    expect(logs.some((m) => m.includes('conexão recusada'))).toBe(true)
    const tudo = JSON.stringify({ logs, gravado, eventos, resumo })
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
  })

  it('erro com a credencial do App, citada solta no meio do texto, também sai mascarado', async () => {
    const { logs } = await passadaQueLanca(() => `falha com ${TOKEN_DO_APP} embutido`)

    expect(logs.some((m) => m.includes('falha com'))).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(TOKEN_DO_APP)
  })
})
