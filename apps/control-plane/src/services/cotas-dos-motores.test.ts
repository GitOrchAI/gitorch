import { test, expect, describe, vi } from 'vitest'
import { lerCotasDosMotores, NOMES_DOS_MOTORES } from './cotas-dos-motores.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Uma linha de engine_connections como o banco de produção devolve.
const linha = (over: Record<string, any> = {}) => ({
  runtime: 'claude',
  status: 'connected',
  sessionPercentUsed: 1,
  weekPercentUsed: 27,
  sessionResetsAt: null,
  weekResetsAt: null,
  quotaRefreshedAt: new Date('2026-08-30T16:53:24.105Z'),
  lastError: null,
  ...over,
})

const prismaCom = (linhas: any[]) => ({
  engineConnection: { findMany: vi.fn().mockResolvedValue(linhas) },
})

describe('lerCotasDosMotores', () => {
  test('devolve o que está gravado, não uma lista vazia', async () => {
    // O defeito que esta função existe para matar: o painel mostrava
    // "nenhum motor conectado" com o banco cheio (30/08/2026).
    const prisma = prismaCom([
      linha({ runtime: 'claude', sessionPercentUsed: 1, weekPercentUsed: 27 }),
      linha({
        runtime: 'antigravity',
        sessionPercentUsed: 0,
        weekPercentUsed: 56,
        quotaRefreshedAt: new Date('2026-08-30T17:01:29.323Z'),
      }),
    ])

    const motores = await lerCotasDosMotores(prisma as any, 'owner_1')

    expect(motores).toHaveLength(2)
    expect(motores[0]).toMatchObject({
      id: 'claude',
      nome: 'Claude Code',
      estado: 'ligado',
      sessao: 1,
      semana: 27,
      precisaReligar: false,
    })
    expect(motores[0]?.lidoEm).toBe('2026-08-30T16:53:24.105Z')
    expect(motores[1]).toMatchObject({ id: 'antigravity', semana: 56 })
  })

  test('escopo: só os motores do dono da sessão', async () => {
    const prisma = prismaCom([])
    await lerCotasDosMotores(prisma as any, 'owner_1')
    expect(prisma.engineConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'owner_1' }) })
    )
  })

  test('motor que precisa religar aparece dito, não como ligado', async () => {
    // O assistente já mostrou "Codex Conectado" com o motor morto havia uma
    // hora. Aqui o estado vem do que foi medido, não do otimismo.
    const prisma = prismaCom([
      linha({
        runtime: 'codex',
        status: 'needs_reconnect',
        sessionPercentUsed: null,
        weekPercentUsed: null,
        lastError: 'Failed to refresh token: 401',
      }),
    ])

    const [codex] = await lerCotasDosMotores(prisma as any, 'owner_1')

    expect(codex?.estado).toBe('precisa_religar')
    expect(codex?.precisaReligar).toBe(true)
  })

  test('sem número lido, diz que não sabe — nunca zero', async () => {
    // Zero é um número. "Não sei" não é zero: exibir 0% de uso faria o dono
    // achar que tem a cota inteira disponível.
    const prisma = prismaCom([
      linha({
        runtime: 'github',
        sessionPercentUsed: null,
        weekPercentUsed: null,
        quotaRefreshedAt: null,
      }),
    ])

    const [github] = await lerCotasDosMotores(prisma as any, 'owner_1')

    expect(github?.sessao).toBeNull()
    expect(github?.semana).toBeNull()
    expect(github?.lidoEm).toBeNull()
  })

  test('dono sem motor nenhum devolve lista vazia — e isso é verdade, não falha', async () => {
    const motores = await lerCotasDosMotores(prismaCom([]) as any, 'owner_1')
    expect(motores).toEqual([])
  })

  test('runtime desconhecido não some da lista', async () => {
    // Melhor mostrar o nome cru do que esconder um motor que existe.
    const prisma = prismaCom([linha({ runtime: 'motor-novo' })])
    const [m] = await lerCotasDosMotores(prisma as any, 'owner_1')
    expect(m?.id).toBe('motor-novo')
    expect(m?.nome).toBe('motor-novo')
  })

  test('os nomes de exibição são os mesmos do assistente', () => {
    // Dois nomes para o mesmo motor em telas diferentes confundem o dono.
    expect(NOMES_DOS_MOTORES['claude']).toBe('Claude Code')
    expect(NOMES_DOS_MOTORES['codex']).toBe('Codex')
    expect(NOMES_DOS_MOTORES['antigravity']).toBe('Antigravity')
  })
})
