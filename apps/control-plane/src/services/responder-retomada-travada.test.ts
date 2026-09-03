import { describe, it, expect, vi } from 'vitest'
import {
  aoResponderRetomadaTravada,
  MARCADOR_PR_ENCERRADO_PELO_DONO,
  MARCADOR_PR_ASSUMIDO_PELO_DONO,
  type DepsDeRespostaDeRetomada,
} from './responder-retomada-travada.js'
import { dedupKeyDeRetomada } from './dedup-key-de-retomada.js'

// C2 (fix-up L4-T5, CSO): a pergunta de "retomada travada" (dedupKey
// `retomada-travada:<repo>:<pr>`, plugins/scheduler.ts) tinha 4 opções (D71 —
// 3 objetivas + livre) e NINGUÉM consumia a resposta. O dono clicava, a
// pergunta sumia da tela, e nada acontecia — a mesma classe de defeito já
// corrigida para `automacao:*` (L4-T2) e `duvida-dev:*` (L4-T3). Este módulo
// é o manipulador (`ManipuladorDeResposta`) desta dedupKey, ligado em
// `plugins/telegram.ts` como os outros dois.
//
// Os VALUES reais das opções (scheduler.ts): 'tentar-de-novo',
// 'fechar-e-recomecar', 'revisar-manualmente' — a 4ª (`buildFreeTextOption`)
// entrega o TEXTO LIVRE do dono como `resposta` (nunca o placeholder da
// opção), então qualquer valor que não bate as 3 primeiras é tratado como
// "Vou escrever" (D71) — mesmo contrato de `processarRespostaDeAutomacao`.

function projetoFalso(overrides: Record<string, unknown> = {}) {
  return { id: 'proj-1', wingId: 'loureng/patinhas-3d-crafts', ...overrides }
}

function sessaoAnteriorFalsa(overrides: Record<string, unknown> = {}) {
  return {
    issueNumber: 3884,
    sessionName: 'sessions/velha',
    pullRequestNumber: 3917,
    ...overrides,
  }
}

function depsFake(over: Partial<DepsDeRespostaDeRetomada> = {}): {
  deps: DepsDeRespostaDeRetomada
  comentar: ReturnType<typeof vi.fn>
  fecharPr: ReturnType<typeof vi.fn>
  criarSessaoDev: ReturnType<typeof vi.fn>
  registrarSessaoRetomada: ReturnType<typeof vi.fn>
  findUnique: ReturnType<typeof vi.fn>
  findFirst: ReturnType<typeof vi.fn>
} {
  const findUnique = vi.fn(async () => projetoFalso())
  const findFirst = vi.fn(async () => sessaoAnteriorFalsa())
  const comentar = vi.fn(async () => undefined)
  const fecharPr = vi.fn(async () => undefined)
  const lerPr = vi.fn(async () => ({ headRef: 'jules-3917-branch' }))
  const criarSessaoDev = vi.fn(async () => ({
    situacao: 'criada' as const,
    sessionName: 'sessions/nova',
  }))
  const registrarSessaoRetomada = vi.fn(async () => undefined)
  const deps: DepsDeRespostaDeRetomada = {
    prisma: {
      project: { findUnique },
      devSession: { findFirst },
    },
    lerPr,
    comentar,
    fecharPr,
    criarSessaoDev,
    registrarSessaoRetomada,
    onWarn: () => undefined,
    onInfo: () => undefined,
    ...over,
  }
  return {
    deps,
    comentar,
    fecharPr,
    criarSessaoDev,
    registrarSessaoRetomada,
    findUnique,
    findFirst,
  }
}

const DEDUP_KEY = dedupKeyDeRetomada({ repo: 'loureng/patinhas-3d-crafts', prNumber: 3917 })

describe('aoResponderRetomadaTravada', () => {
  it('dedupKey de outro tipo (não retomada-travada:) → no-op', async () => {
    const { deps, comentar, fecharPr, criarSessaoDev } = depsFake()
    await aoResponderRetomadaTravada(
      { dedupKey: 'automacao:o/r:wf:1', resposta: 'deletar', projectId: 'proj-1' },
      deps
    )
    expect(comentar).not.toHaveBeenCalled()
    expect(fecharPr).not.toHaveBeenCalled()
    expect(criarSessaoDev).not.toHaveBeenCalled()
  })

  it('projeto não encontrado → lança, nunca finge sucesso', async () => {
    const { deps } = depsFake({
      prisma: {
        project: { findUnique: vi.fn(async () => null) },
        devSession: { findFirst: vi.fn(async () => null) },
      },
    })
    await expect(
      aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: 'tentar-de-novo', projectId: 'proj-1' },
        deps
      )
    ).rejects.toThrow()
  })

  it('repo do dedupKey diverge do wingId do projeto (cross-tenant) → lança', async () => {
    const { deps } = depsFake({
      prisma: {
        project: { findUnique: vi.fn(async () => projetoFalso({ wingId: 'outro/repo' })) },
        devSession: { findFirst: vi.fn(async () => sessaoAnteriorFalsa()) },
      },
    })
    await expect(
      aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: 'tentar-de-novo', projectId: 'proj-1' },
        deps
      )
    ).rejects.toThrow(/diverge/)
  })

  describe("'tentar-de-novo'", () => {
    it('zera a contagem (força retomar) e chama criarSessaoDev/registrarSessaoRetomada com o MESMO PR', async () => {
      const { deps, criarSessaoDev, registrarSessaoRetomada } = depsFake()
      await aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: 'tentar-de-novo', projectId: 'proj-1' },
        deps
      )
      expect(criarSessaoDev).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: 'loureng/patinhas-3d-crafts',
          startingBranch: 'jules-3917-branch',
          workingBranch: 'jules-3917-branch',
        })
      )
      expect(registrarSessaoRetomada).toHaveBeenCalledWith({
        issueNumber: 3884,
        sessionName: 'sessions/nova',
        prNumber: 3917,
      })
    })

    it('sem sessão anterior encontrada para este PR → lança, nunca adivinha a issue', async () => {
      const { deps } = depsFake({
        prisma: {
          project: { findUnique: vi.fn(async () => projetoFalso()) },
          devSession: { findFirst: vi.fn(async () => null) },
        },
      })
      await expect(
        aoResponderRetomadaTravada(
          { dedupKey: DEDUP_KEY, resposta: 'tentar-de-novo', projectId: 'proj-1' },
          deps
        )
      ).rejects.toThrow()
    })

    it('a retomada forçada falha (dev recusa) → lança, a pergunta continua open para nova tentativa', async () => {
      const { deps } = depsFake({
        criarSessaoDev: vi.fn(async () => ({ situacao: 'falhou' as const, motivo: 'sem vaga' })),
      })
      await expect(
        aoResponderRetomadaTravada(
          { dedupKey: DEDUP_KEY, resposta: 'tentar-de-novo', projectId: 'proj-1' },
          deps
        )
      ).rejects.toThrow(/sem vaga/)
    })
  })

  describe("'fechar-e-recomecar'", () => {
    it('comenta com o marcador e fecha o PR do dev — nunca abre sessão nova', async () => {
      const { deps, comentar, fecharPr, criarSessaoDev } = depsFake()
      await aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: 'fechar-e-recomecar', projectId: 'proj-1' },
        deps
      )
      expect(comentar).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: 'loureng/patinhas-3d-crafts',
          prNumber: 3917,
          comentario: expect.stringContaining(MARCADOR_PR_ENCERRADO_PELO_DONO),
        })
      )
      expect(fecharPr).toHaveBeenCalledWith({
        repository: 'loureng/patinhas-3d-crafts',
        prNumber: 3917,
      })
      expect(criarSessaoDev).not.toHaveBeenCalled()
    })
  })

  describe("'revisar-manualmente'", () => {
    it('comenta que o dono assumiu, com marcador — NUNCA fecha o PR', async () => {
      const { deps, comentar, fecharPr } = depsFake()
      await aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: 'revisar-manualmente', projectId: 'proj-1' },
        deps
      )
      expect(comentar).toHaveBeenCalledWith(
        expect.objectContaining({
          comentario: expect.stringContaining(MARCADOR_PR_ASSUMIDO_PELO_DONO),
        })
      )
      expect(fecharPr).not.toHaveBeenCalled()
    })
  })

  describe("'escrever' (texto livre — D71)", () => {
    it('qualquer resposta fora das 3 opções conhecidas vira comentário sanitizado', async () => {
      const { deps, comentar } = depsFake()
      await aoResponderRetomadaTravada(
        {
          dedupKey: DEDUP_KEY,
          resposta: 'Já conversei com o time do cliente, pode fechar amanhã.',
          projectId: 'proj-1',
        },
        deps
      )
      expect(comentar).toHaveBeenCalledWith(
        expect.objectContaining({
          comentario: expect.stringContaining('Já conversei com o time do cliente'),
        })
      )
    })

    it('vazia/só espaço → NÃO comenta nada', async () => {
      const { deps, comentar } = depsFake()
      await aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: '   ', projectId: 'proj-1' },
        deps
      )
      expect(comentar).not.toHaveBeenCalled()
    })

    it('injeção: @menção e /comando são neutralizados (mesma sanitização de decisao-de-automacao.ts)', async () => {
      const { deps, comentar } = depsFake()
      await aoResponderRetomadaTravada(
        { dedupKey: DEDUP_KEY, resposta: '@alguem /close isso aqui', projectId: 'proj-1' },
        deps
      )
      const chamada = comentar.mock.calls[0]![0] as { comentario: string }
      expect(chamada.comentario).not.toMatch(/(^|\s)@alguem/)
      expect(chamada.comentario).not.toMatch(/(^|\s)\/close/)
    })
  })
})
