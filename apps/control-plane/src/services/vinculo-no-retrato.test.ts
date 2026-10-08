import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  criarVinculadorDeTarefa,
  ETIQUETA_DE_DELEGACAO,
  JANELA_DO_CACHE_NEGATIVO_MS,
  type DepsDoVinculador,
} from './vinculo-no-retrato.js'
import { limparFreiosDeCota, registrarFreioDeCota } from './freio-de-cota-do-github.js'
import { ErroDoGitHub } from './erro-do-github.js'

const AGORA = new Date('2026-10-01T12:00:00.000Z')

function prFalso(numero: number, extra: Record<string, unknown> = {}) {
  return {
    number: numero,
    body: '',
    user: { login: 'autor-humano' },
    head: { ref: 'minha-feature' },
    ...extra,
  }
}

function montar(sobrescrever: Partial<DepsDoVinculador> = {}) {
  const gravar = vi.fn(async (_args: unknown) => undefined)
  const registrarNoPainel = vi.fn(async (_args: unknown) => undefined)
  const closingIssues = vi.fn(async (_numero: number): Promise<number[]> => [])
  const lerSessoes = vi.fn(async () => [] as Awaited<ReturnType<DepsDoVinculador['lerSessoes']>>)
  const lerFicha = vi.fn(async (_numero: number) => ({
    origem: 'pessoa' as string | null,
    issueNumber: null as number | null,
  }))
  let agora = AGORA
  const deps: DepsDoVinculador = {
    projectId: 'proj_1',
    repo: 'acme/api',
    lerFicha,
    lerSessoes,
    closingIssues,
    gravar,
    registrarNoPainel,
    cacheNegativo: new Map(),
    agora: () => agora,
    info: vi.fn(),
    onWarn: vi.fn(),
    ...sobrescrever,
  }
  // Os espiões expostos são os que `deps` de fato carrega (um override do teste vale).
  return {
    deps,
    gravar: deps.gravar as unknown as typeof gravar,
    registrarNoPainel: deps.registrarNoPainel as unknown as typeof registrarNoPainel,
    closingIssues: deps.closingIssues as unknown as typeof closingIssues,
    lerSessoes: deps.lerSessoes as unknown as typeof lerSessoes,
    lerFicha: deps.lerFicha as unknown as typeof lerFicha,
    aplicar: criarVinculadorDeTarefa(deps),
    avancar: (ms: number) => {
      agora = new Date(agora.getTime() + ms)
    },
  }
}

const semEtiqueta = (): string[] => []

describe('criarVinculadorDeTarefa', () => {
  beforeEach(() => limparFreiosDeCota())
  afterEach(() => limparFreiosDeCota())

  it('PR com linha de sessão guardada: acha a tarefa SEM chamar o GraphQL e corrige a origem', async () => {
    const m = montar({
      lerSessoes: vi.fn(async () => [
        { sessionName: 'sessions/1', issueNumber: 3842, pullRequestNumber: 4072 },
      ]),
    })

    const gastou = await m.aplicar({
      numero: 4072,
      pr: prFalso(4072),
      etiquetasDaIssue: semEtiqueta,
    })

    expect(gastou).toBe(true)
    expect(m.closingIssues).not.toHaveBeenCalled()
    expect(m.gravar).toHaveBeenCalledWith({
      numero: 4072,
      issueNumber: 3842,
      vinculoOrigem: 'texto',
      origem: 'jules_gitorch',
    })
    expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
    expect(m.registrarNoPainel).toHaveBeenCalledWith(
      expect.objectContaining({ chave: 'vinculo-da-tarefa:acme/api:4072:3842' })
    )
  })

  it('origem jules_fora ou nula também é corrigida; assistente NÃO é mexida', async () => {
    const sessoes = [{ sessionName: 'sessions/1', issueNumber: 10, pullRequestNumber: 5 }]
    for (const [origem, esperada] of [
      ['jules_fora', 'jules_gitorch'],
      [null, 'jules_gitorch'],
      ['assistente', undefined],
    ] as const) {
      const m = montar({
        lerSessoes: vi.fn(async () => sessoes),
        lerFicha: vi.fn(async () => ({ origem, issueNumber: null })),
      })
      await m.aplicar({ numero: 5, pr: prFalso(5), etiquetasDaIssue: semEtiqueta })
      const arg = m.gravar.mock.calls[0]![0] as Record<string, unknown>
      expect(arg['origem'], `origem ${String(origem)}`).toBe(esperada)
    }
  })

  it('camada FORMAL só vincula: não mexe na origem, mesmo para PR de gente', async () => {
    const m = montar({ closingIssues: vi.fn(async () => [4036]) })

    await m.aplicar({
      numero: 4037,
      pr: prFalso(4037, { body: 'Fixes #4036' }),
      etiquetasDaIssue: semEtiqueta,
    })

    expect(m.closingIssues).toHaveBeenCalledTimes(1)
    expect(m.gravar).toHaveBeenCalledWith({
      numero: 4037,
      issueNumber: 4036,
      vinculoOrigem: 'formal',
    })
    const arg = m.gravar.mock.calls[0]![0] as Record<string, unknown>
    expect(arg).not.toHaveProperty('origem')
  })

  it('branch do Jules: vincula e corrige a origem', async () => {
    const m = montar({
      lerSessoes: vi.fn(async () => [
        { sessionName: 'sessions/121123025271330309061', issueNumber: 55, pullRequestNumber: null },
      ]),
    })

    await m.aplicar({
      numero: 7,
      pr: prFalso(7, { head: { ref: 'jules-121123025271330309061-e9d57552' } }),
      etiquetasDaIssue: semEtiqueta,
    })

    expect(m.gravar).toHaveBeenCalledWith({
      numero: 7,
      issueNumber: 55,
      vinculoOrigem: 'branch-do-jules',
      origem: 'jules_gitorch',
    })
  })

  it('texto "closes #N" + sessão da issue + etiqueta de delegação: vincula como texto, sem mexer na origem', async () => {
    const m = montar({
      lerSessoes: vi.fn(async () => [
        { sessionName: 'sessions/9', issueNumber: 74, pullRequestNumber: null },
      ]),
    })

    await m.aplicar({
      numero: 99,
      pr: prFalso(99, { body: 'closes #74' }),
      etiquetasDaIssue: (n) => (n === 74 ? [ETIQUETA_DE_DELEGACAO] : []),
    })

    const arg = m.gravar.mock.calls[0]![0] as Record<string, unknown>
    expect(arg).toMatchObject({ numero: 99, issueNumber: 74, vinculoOrigem: 'texto' })
    expect(arg).not.toHaveProperty('origem')
  })

  it('texto "closes #N" SEM etiqueta de delegação na issue não vincula (trava contra citação solta)', async () => {
    const m = montar({
      lerSessoes: vi.fn(async () => [
        { sessionName: 'sessions/9', issueNumber: 74, pullRequestNumber: null },
      ]),
    })

    await m.aplicar({
      numero: 99,
      pr: prFalso(99, { body: 'closes #74' }),
      etiquetasDaIssue: semEtiqueta,
    })

    expect(m.gravar).not.toHaveBeenCalled()
  })

  it('não faz nada (e não gasta o teto) quando a ficha não existe, já tem issue, ou é bot', async () => {
    const semFicha = montar({ lerFicha: vi.fn(async () => null) })
    expect(
      await semFicha.aplicar({ numero: 1, pr: prFalso(1), etiquetasDaIssue: semEtiqueta })
    ).toBe(false)

    const jaTem = montar({ lerFicha: vi.fn(async () => ({ origem: 'pessoa', issueNumber: 12 })) })
    expect(await jaTem.aplicar({ numero: 1, pr: prFalso(1), etiquetasDaIssue: semEtiqueta })).toBe(
      false
    )

    for (const origem of ['dependabot', 'outro_bot']) {
      const bot = montar({ lerFicha: vi.fn(async () => ({ origem, issueNumber: null })) })
      expect(await bot.aplicar({ numero: 1, pr: prFalso(1), etiquetasDaIssue: semEtiqueta })).toBe(
        false
      )
      expect(bot.closingIssues).not.toHaveBeenCalled()
      expect(bot.lerSessoes).not.toHaveBeenCalled()
    }
    for (const m of [semFicha, jaTem]) {
      expect(m.closingIssues).not.toHaveBeenCalled()
      expect(m.gravar).not.toHaveBeenCalled()
    }
  })

  it('cache negativo: PR sem vínculo não é reconsultado em menos de 6 h; depois disso, é', async () => {
    const m = montar()

    expect(await m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })).toBe(true)
    expect(m.closingIssues).toHaveBeenCalledTimes(1)

    m.avancar(JANELA_DO_CACHE_NEGATIVO_MS - 60_000)
    expect(await m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })).toBe(
      false
    )
    expect(m.closingIssues).toHaveBeenCalledTimes(1)

    m.avancar(120_000)
    expect(await m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })).toBe(true)
    expect(m.closingIssues).toHaveBeenCalledTimes(2)
    expect(m.gravar).not.toHaveBeenCalled()
  })

  it('PR em cache negativo que ganha linha de sessão é vinculado no ciclo seguinte, sem esperar as 6 h', async () => {
    const sessoes: Array<{ sessionName: string; issueNumber: number; pullRequestNumber: number }> =
      []
    // Cada ciclo monta um vinculador novo e relê as sessões; o cache negativo
    // é o mapa que sobrevive entre eles.
    const cacheNegativo = new Map<string, number>()
    const ciclo = () => montar({ cacheNegativo, lerSessoes: vi.fn(async () => [...sessoes]) })

    const primeiro = ciclo()
    expect(
      await primeiro.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })
    ).toBe(true)
    expect(primeiro.gravar).not.toHaveBeenCalled()
    expect(cacheNegativo.size).toBe(1)

    // A sessão do dev é criada logo depois, bem dentro da janela do cache.
    sessoes.push({ sessionName: 'sessions/9', issueNumber: 77, pullRequestNumber: 8 })
    const seguinte = ciclo()
    seguinte.avancar(60_000)
    expect(
      await seguinte.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })
    ).toBe(true)
    expect(seguinte.closingIssues).not.toHaveBeenCalled()
    expect(seguinte.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ numero: 8, issueNumber: 77, origem: 'jules_gitorch' })
    )
    expect(cacheNegativo.size).toBe(0)
  })

  it('o cache negativo é por projeto e PR (outro PR continua sendo consultado)', async () => {
    const m = montar()
    await m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })
    await m.aplicar({ numero: 9, pr: prFalso(9), etiquetasDaIssue: semEtiqueta })
    expect(m.closingIssues).toHaveBeenCalledTimes(2)
  })

  it('freio de cota ativo: pula o GraphQL com UMA linha de log, não cacheia o "sem vínculo", e as camadas locais seguem valendo', async () => {
    const erro = new ErroDoGitHub('limite', {
      status: 429,
      retryAfterSegundos: 300,
      limiteRestante: 0,
      limiteResetaEmSegundos: null,
    })
    registrarFreioDeCota('acme', erro, AGORA)
    const m = montar({
      lerSessoes: vi.fn(async () => [
        { sessionName: 'sessions/1', issueNumber: 3, pullRequestNumber: 20 },
      ]),
    })

    // PR sem pista local: não consulta o GitHub e não vira "sem vínculo" por 6 h.
    expect(await m.aplicar({ numero: 21, pr: prFalso(21), etiquetasDaIssue: semEtiqueta })).toBe(
      true
    )
    expect(await m.aplicar({ numero: 22, pr: prFalso(22), etiquetasDaIssue: semEtiqueta })).toBe(
      true
    )
    expect(m.closingIssues).not.toHaveBeenCalled()
    expect(m.deps.cacheNegativo.size).toBe(0)
    expect(m.deps.info).toHaveBeenCalledTimes(1)
    expect(String((m.deps.info as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      'freio de cota'
    )

    // PR com linha de sessão continua vinculando.
    await m.aplicar({ numero: 20, pr: prFalso(20), etiquetasDaIssue: semEtiqueta })
    expect(m.gravar).toHaveBeenCalledWith(expect.objectContaining({ numero: 20, issueNumber: 3 }))
  })

  it('erro na consulta formal sobe para quem chamou e NÃO cria cache negativo', async () => {
    const m = montar({
      closingIssues: vi.fn(async () => {
        throw new Error('graphql fora do ar')
      }),
    })

    await expect(
      m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })
    ).rejects.toThrow('graphql fora do ar')
    expect(m.deps.cacheNegativo.size).toBe(0)
  })

  it('falha no painel não desfaz o vínculo já gravado (avisa e segue)', async () => {
    const m = montar({
      closingIssues: vi.fn(async () => [4036]),
      registrarNoPainel: vi.fn(async () => {
        throw new Error('painel fora')
      }),
    })

    expect(
      await m.aplicar({ numero: 4037, pr: prFalso(4037), etiquetasDaIssue: semEtiqueta })
    ).toBe(true)
    expect(m.gravar).toHaveBeenCalledTimes(1)
    expect(m.deps.onWarn).toHaveBeenCalledTimes(1)
  })

  it('carrega as sessões do projeto uma vez só, mesmo para vários PRs', async () => {
    const m = montar()
    await m.aplicar({ numero: 1, pr: prFalso(1), etiquetasDaIssue: semEtiqueta })
    await m.aplicar({ numero: 2, pr: prFalso(2), etiquetasDaIssue: semEtiqueta })
    await m.aplicar({ numero: 3, pr: prFalso(3), etiquetasDaIssue: semEtiqueta })
    expect(m.lerSessoes).toHaveBeenCalledTimes(1)
  })

  it('vínculo achado depois de um "sem vínculo" limpa a marca do cache', async () => {
    const closing = vi.fn(async (): Promise<number[]> => [])
    const m = montar({ closingIssues: closing })
    await m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })
    expect(m.deps.cacheNegativo.size).toBe(1)

    m.avancar(JANELA_DO_CACHE_NEGATIVO_MS + 1)
    closing.mockResolvedValueOnce([77])
    await m.aplicar({ numero: 8, pr: prFalso(8), etiquetasDaIssue: semEtiqueta })
    expect(m.deps.cacheNegativo.size).toBe(0)
    expect(m.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ numero: 8, issueNumber: 77, vinculoOrigem: 'formal' })
    )
  })
})
