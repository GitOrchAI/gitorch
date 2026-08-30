import { test, expect, describe, vi } from 'vitest'
import { lerCotasDosMotores, NOMES_DOS_MOTORES } from './cotas-dos-motores.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Uma linha de engine_connections como o banco de produção devolve.
//
// As janelas viram NO FUTURO de propósito: percentual de janela já vencida é
// suprimido (vira null), e uma fixture sem horário de virada faria o teste
// afirmar que números velhos devem aparecer — consagrando o defeito em vez de
// pegá-lo.
const DAQUI_A_POUCO = new Date(Date.now() + 3 * 3600_000).toISOString()
const linha = (over: Record<string, any> = {}) => ({
  runtime: 'claude',
  status: 'connected',
  sessionPercentUsed: 1,
  weekPercentUsed: 27,
  sessionResetsAt: DAQUI_A_POUCO,
  weekResetsAt: DAQUI_A_POUCO,
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

  test('percentual de janela JÁ VENCIDA vira "não sei", nunca é exibido', async () => {
    // O caso real de 30/08: a linha do Claude guardava semana=99%, lida dois
    // dias antes, com a janela já virada. A leitura ao vivo deu 24%. Mostrar o
    // 99% seria um erro de 75 pontos percentuais com cara de fato — e faria o
    // dono parar de trabalhar para "não estourar a conta".
    const ONTEM = new Date(Date.now() - 24 * 3600_000).toISOString()
    const prisma = prismaCom([
      linha({
        sessionPercentUsed: 99,
        weekPercentUsed: 99,
        sessionResetsAt: ONTEM,
        weekResetsAt: ONTEM,
      }),
    ])

    const [m] = await lerCotasDosMotores(prisma as any, 'owner_1')

    expect(m?.sessao).toBeNull()
    expect(m?.semana).toBeNull()
    // Mas o carimbo de quando foi lida permanece: o dono precisa saber que a
    // leitura existe e está velha, não que nunca houve leitura.
    expect(m?.lidoEm).not.toBeNull()
  })

  test('sem horário de virada, o percentual não é servido', async () => {
    // Sem saber quando a janela vira, não dá para dizer se o número ainda vale.
    // A mesma regra do assistente: na dúvida, não afirma.
    const prisma = prismaCom([linha({ sessionResetsAt: null, weekResetsAt: null })])
    const [m] = await lerCotasDosMotores(prisma as any, 'owner_1')
    expect(m?.sessao).toBeNull()
    expect(m?.semana).toBeNull()
  })

  test('o GitHub NÃO entra na lista de motores', async () => {
    // `github` é a credencial que abre o repositório, não um motor de IA. Não
    // tem janela de cota e nenhum leitor escreve percentual para ela — se
    // entrasse na lista, ficaria para sempre dizendo "não consegui ler a cota
    // deste motor", com um botão de tentar de novo que nunca funcionaria.
    // A mesma deny-list que EngineConnectionService.list já aplica.
    const prisma = prismaCom([])
    await lerCotasDosMotores(prisma as any, 'owner_1')
    expect(prisma.engineConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runtime: { not: 'github' } }),
      })
    )
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
