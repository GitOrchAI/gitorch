import { describe, it, expect, vi } from 'vitest'
import {
  varrerIssuesForaDoQuadro,
  TETO_DE_PAGINAS_DA_VARREDURA,
} from './varrer-issues-fora-do-quadro.js'

// L4-T8 — a REDE DE SEGURANÇA: uma issue que nasceu por um caminho que ainda
// não pendura no quadro (ou tentou e falhou best-effort) não pode ficar fora
// para sempre. Esta varredura lista TODAS as issues abertas do repositório
// (GraphQL paginado) e pendura no quadro qualquer uma que ainda não esteja lá.

interface NoDeIssue {
  id: string
  number: number
  projectItems: { nodes: Array<{ project: { id: string } }> }
}

function pagina(
  nodes: NoDeIssue[],
  opts: { hasNextPage?: boolean; endCursor?: string | null } = {}
) {
  return {
    repository: {
      issues: {
        nodes,
        pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.endCursor ?? null },
      },
    },
  }
}

function issue(number: number, projetos: string[] = []): NoDeIssue {
  return {
    id: `NODE_${number}`,
    number,
    projectItems: { nodes: projetos.map((id) => ({ project: { id } })) },
  }
}

describe('varrerIssuesForaDoQuadro', () => {
  it('só anexa as issues que estão FORA do quadro do projeto', async () => {
    const gql = vi
      .fn()
      .mockResolvedValue(pagina([issue(1, ['P1']), issue(2, ['OUTRO_P']), issue(3, [])]))
    const anexarAoQuadro = vi.fn().mockResolvedValue(undefined)

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro,
    })

    // #1 já está no quadro certo (P1) — não anexa.
    // #2 está em OUTRO quadro — conta como fora, anexa.
    // #3 não está em nenhum — conta como fora, anexa.
    expect(anexarAoQuadro).toHaveBeenCalledTimes(2)
    expect(anexarAoQuadro).toHaveBeenCalledWith('NODE_2')
    expect(anexarAoQuadro).toHaveBeenCalledWith('NODE_3')
    expect(resultado).toEqual({ repo: 'dono/repo', abertas: 3, fora: 2, anexadas: 2, falhas: 0 })
  })

  it('paginação com teto: nunca gira além do teto de páginas', async () => {
    const gql = vi.fn().mockResolvedValue(pagina([], { hasNextPage: true, endCursor: 'CURSOR' }))
    const anexarAoQuadro = vi.fn()

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro,
      tetoDePaginas: 3,
    })

    expect(gql).toHaveBeenCalledTimes(3)
    expect(resultado.abertas).toBe(0)
  })

  it('teto PADRÃO é 10 páginas quando não informado', async () => {
    const gql = vi.fn().mockResolvedValue(pagina([], { hasNextPage: true, endCursor: 'C' }))
    await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro: vi.fn(),
    })
    expect(gql).toHaveBeenCalledTimes(TETO_DE_PAGINAS_DA_VARREDURA)
  })

  it('para de paginar assim que `hasNextPage` vem falso', async () => {
    const gql = vi
      .fn()
      .mockResolvedValueOnce(pagina([issue(1, ['P1'])], { hasNextPage: true, endCursor: 'C1' }))
      .mockResolvedValueOnce(pagina([issue(2, ['P1'])], { hasNextPage: false }))

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro: vi.fn(),
    })

    expect(gql).toHaveBeenCalledTimes(2)
    expect(gql).toHaveBeenNthCalledWith(2, expect.any(String), {
      owner: 'dono',
      name: 'repo',
      after: 'C1',
    })
    expect(resultado.abertas).toBe(2)
  })

  it('so_olhar NUNCA escreve — nem tenta ler: gql e anexarAoQuadro não são chamados', async () => {
    const gql = vi.fn()
    const anexarAoQuadro = vi.fn()

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'so_olhar',
      gql,
      anexarAoQuadro,
    })

    expect(gql).not.toHaveBeenCalled()
    expect(anexarAoQuadro).not.toHaveBeenCalled()
    expect(resultado).toEqual({ repo: 'dono/repo', abertas: 0, fora: 0, anexadas: 0, falhas: 0 })
  })

  it('nível ausente/desconhecido também não escreve (mesmo lado seguro do padrão do produto)', async () => {
    const gql = vi.fn()
    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: null,
      gql,
      anexarAoQuadro: vi.fn(),
    })
    expect(gql).not.toHaveBeenCalled()
    expect(resultado.abertas).toBe(0)
  })

  // Achado C (revisão do fix-up 2): a lista própria `NIVEIS_QUE_ESCREVEM`
  // duplicava a tabela de `podeEscrever` (packages/cadence) — a MESMA lição
  // do SSRF, regra de autonomia espalhada diverge da central. Um valor
  // NENHUM dos três nomes reconhecidos (nem 'so_olhar' nem null/undefined,
  // que já tinham teste acima) prova que a checagem agora passa por
  // `normalizarNivel` (fail-closed) e não por um `.has()` numa string crua.
  it('nível é um texto desconhecido (nem um dos 3 nomes válidos): cai no lado seguro, não escreve', async () => {
    const gql = vi.fn()
    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'nivel-que-nao-existe',
      gql,
      anexarAoQuadro: vi.fn(),
    })
    expect(gql).not.toHaveBeenCalled()
    expect(resultado).toEqual({ repo: 'dono/repo', abertas: 0, fora: 0, anexadas: 0, falhas: 0 })
  })

  it('contagem e log por repositório, no formato esperado pelo relógio', async () => {
    const gql = vi.fn().mockResolvedValue(pagina([issue(1, []), issue(2, ['P1'])]))
    const onInfo = vi.fn()

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'acme/api',
      projectId: 'P1',
      nivelDeAutonomia: 'sugerir',
      gql,
      anexarAoQuadro: vi.fn().mockResolvedValue(undefined),
      onInfo,
    })

    expect(resultado).toEqual({ repo: 'acme/api', abertas: 2, fora: 1, anexadas: 1, falhas: 0 })
    expect(onInfo).toHaveBeenCalledWith(
      expect.stringContaining('[Scheduler] quadro acme/api: 1 fora, 1 anexadas, 0 falhas')
    )
  })

  it('falha ao anexar UMA issue não para as outras — segue e conta a falha', async () => {
    const gql = vi.fn().mockResolvedValue(pagina([issue(1, []), issue(2, []), issue(3, [])]))
    const onWarn = vi.fn()
    const anexarAoQuadro = vi.fn(async (nodeId: string) => {
      if (nodeId === 'NODE_2') throw new Error('ECONNRESET')
      return undefined
    })

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro,
      onWarn,
    })

    expect(anexarAoQuadro).toHaveBeenCalledTimes(3)
    expect(resultado).toEqual({ repo: 'dono/repo', abertas: 3, fora: 3, anexadas: 2, falhas: 1 })
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('#2'))
  })

  // Achado B (revisão do fix-up 2): `deps.repositorio` vai colado numa URL
  // que carrega credencial (dentro de `gql`, por quem monta a chamada real).
  // Um valor fora do formato "dono/repositorio" não pode nem chegar ao
  // `.split('/')` — a mesma guarda de porta que `desejo-no-github.ts` já usa.
  it('repositório fora do formato dono/repositorio: recusa ANTES do split, nunca toca a rede, conta falha', async () => {
    const gql = vi.fn()
    const onWarn = vi.fn()

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: '../user/repos?',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro: vi.fn(),
      onWarn,
    })

    expect(gql).not.toHaveBeenCalled()
    expect(resultado).toEqual({
      repo: '../user/repos?',
      abertas: 0,
      fora: 0,
      anexadas: 0,
      falhas: 1,
    })
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('../user/repos?')
  })

  // Achado B — antes desta correção, um `data.repository` nulo (repo
  // renomeado/apagado, permissão perdida no meio do caminho) fazia a função
  // dar um `break` silencioso e reportar "0 fora, 0 anexadas, 0 falhas" pelo
  // `onInfo` — indistinguível de um repositório limpo de verdade.
  it('resposta do GitHub sem repository/issues: conta falha e loga erro explícito, nunca finge "0 fora"', async () => {
    const gql = vi.fn().mockResolvedValue({})
    const onWarn = vi.fn()
    const onInfo = vi.fn()

    const resultado = await varrerIssuesForaDoQuadro({
      repositorio: 'dono/repo-sumiu',
      projectId: 'P1',
      nivelDeAutonomia: 'cuidar',
      gql,
      anexarAoQuadro: vi.fn(),
      onWarn,
      onInfo,
    })

    expect(resultado).toEqual({
      repo: 'dono/repo-sumiu',
      abertas: 0,
      fora: 0,
      anexadas: 0,
      falhas: 1,
    })
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('dono/repo-sumiu')
    // O resumo de sempre (onInfo) não pode dizer "0 falhas" quando a
    // passada inteira falhou antes de ler uma issue sequer.
    expect(onInfo.mock.calls.every(([m]) => !String(m).includes('0 falhas'))).toBe(true)
  })

  // Achado B — o `gql` lançar (erro de rede, ou `GithubExecutionError` de
  // `criarGqlDoGithub` quando a resposta vem com `errors[]`) não pode
  // atravessar esta função: o contrato de `varrerIssuesForaDoQuadro` é
  // "nunca lança", e sem isto o relógio inteiro pararia por causa de UM
  // repositório instável.
  it('gql lança (erros do GraphQL ou rede): nunca escapa da função, conta falha e loga', async () => {
    const gql = vi.fn().mockRejectedValue(new Error('GitHub GraphQL failed: rate limited'))
    const onWarn = vi.fn()

    await expect(
      varrerIssuesForaDoQuadro({
        repositorio: 'dono/repo',
        projectId: 'P1',
        nivelDeAutonomia: 'cuidar',
        gql,
        anexarAoQuadro: vi.fn(),
        onWarn,
      })
    ).resolves.toEqual({ repo: 'dono/repo', abertas: 0, fora: 0, anexadas: 0, falhas: 1 })

    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('rate limited')
  })
})
