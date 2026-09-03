import { describe, it, expect, vi } from 'vitest'
import { executarCicloTerminal, type CicloTerminalDeps } from './executar-ciclo-terminal.js'
import type { LinhaParaCicloTerminal } from './dev-session-store.js'
import type { SituacaoDoPr } from './sessao-terminal.js'

function linha(over: Partial<LinhaParaCicloTerminal>): LinhaParaCicloTerminal {
  return {
    sessionName: 'sessions/x',
    projectId: 'p1',
    issueNumber: 1,
    state: 'COMPLETED',
    pullRequestNumber: null,
    lastProgressAt: new Date('2026-08-28T00:00:00Z'),
    requeueCount: 0,
    analysisDoneAt: null,
    devAccountId: null,
    answeredHash: null,
    ...over,
  }
}

function deps(
  over: Partial<CicloTerminalDeps> & { linhas: LinhaParaCicloTerminal[]; pr?: SituacaoDoPr }
) {
  const fechadas: Array<{ sessionName: string; motivo: string }> = []
  const analises: number[] = []
  const d: CicloTerminalDeps = {
    listarLinhas: async () => over.linhas,
    situacaoDoPr: async () => over.pr ?? 'sem-pr',
    fecharSessao: async ({ linha, motivo }) => {
      fechadas.push({ sessionName: linha.sessionName, motivo })
    },
    pedirAnalise: async ({ linha }) => {
      analises.push(linha.issueNumber)
    },
    agora: new Date('2026-08-29T12:00:00Z'),
    onInfo: () => undefined,
    onWarn: () => undefined,
    ...over,
  }
  return { d, fechadas, analises }
}

describe('executarCicloTerminal', () => {
  it('sessão não-terminal é ignorada', async () => {
    const { d, fechadas } = deps({ linhas: [linha({ state: 'IN_PROGRESS' })] })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([])
    expect(r).toMatchObject({ fechadasConcluidas: 0, issuesRedelegadas: [], mantidas: 0 })
  })

  it('COMPLETED sem PR → fecha (dev-concluiu-sem-entrega), a issue volta à fila', async () => {
    const { d, fechadas, analises } = deps({ linhas: [linha({ issueNumber: 51 })] })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([{ sessionName: 'sessions/x', motivo: 'dev-concluiu-sem-entrega' }])
    expect(analises).toEqual([])
    expect(r.issuesRedelegadas).toEqual([51])
  })

  it('FAILED, 2ª falha na mesma issue → fecha e PEDE ANÁLISE antes da 3ª', async () => {
    const { d, fechadas, analises } = deps({
      linhas: [linha({ issueNumber: 7, state: 'FAILED', requeueCount: 2 })],
    })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([{ sessionName: 'sessions/x', motivo: 'dev-falhou' }])
    expect(analises).toEqual([7])
    expect(r.issuesEmAnalise).toEqual([7])
  })

  it('COMPLETED + PR mesclado → fecha como concluído, NÃO redelega', async () => {
    const { d, fechadas } = deps({
      linhas: [linha({ pullRequestNumber: 99 })],
      pr: 'mesclado',
    })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([{ sessionName: 'sessions/x', motivo: 'merged' }])
    expect(r.issuesRedelegadas).toEqual([])
    expect(r.fechadasConcluidas).toBe(1)
  })

  it('COMPLETED + PR aberto e vivo → mantém', async () => {
    const { d, fechadas } = deps({ linhas: [linha({ pullRequestNumber: 5 })], pr: 'aberto-vivo' })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([])
    expect(r.mantidas).toBe(1)
  })

  it('situacaoDoPr devolve null (não deu para ler) → conta como ilegível, não fecha', async () => {
    const { d, fechadas } = deps({ linhas: [linha({ pullRequestNumber: 5 })] })
    d.situacaoDoPr = async () => null
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([])
    expect(r.ilegiveis).toBe(1)
  })

  it('respeita o teto por varredura', async () => {
    const linhas = Array.from({ length: 5 }, (_, i) =>
      linha({ sessionName: `sessions/${i}`, issueNumber: i })
    )
    const { d, fechadas } = deps({ linhas })
    d.teto = 2
    await executarCicloTerminal(d)
    expect(fechadas).toHaveLength(2)
  })

  // L4-T4, fix-up 5 (task a13a42f8-2953-4259-b41f-3f8cddb304cd) — CENÁRIO
  // EXATO de produção (03/09): sessão COMPLETED (estado remoto do Jules já
  // sincronizado) + PR aberto-rejeitado-parado além das 12h, mas com marca
  // `escalada:0:<hash>` em `answeredHash` — a dúvida ainda espera o dono.
  // Antes deste fix-up, `[ciclo-terminal] ... fechada (pr-rejeitado-sem-retomada)`
  // era exatamente isto.
  it('COMPLETED + PR rejeitado além das 12h, mas com marca escalada → NÃO fecha (cenário exato de produção)', async () => {
    const { d, fechadas } = deps({
      linhas: [linha({ issueNumber: 3787, answeredHash: 'escalada:0:abc123' })],
      pr: 'aberto-rejeitado-parado',
    })
    d.agora = new Date('2026-08-28T13:00:00Z') // 13h depois de lastProgressAt
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([])
    expect(r.mantidas).toBe(1)
    expect(r.issuesRedelegadas).toEqual([])
  })

  it('FAILED sem PR, mas com marca escalada → NÃO fecha nem pede análise', async () => {
    const { d, fechadas, analises } = deps({
      linhas: [linha({ state: 'FAILED', answeredHash: 'escalada:0:abc123', requeueCount: 2 })],
    })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([])
    expect(analises).toEqual([])
    expect(r.mantidas).toBe(1)
  })

  it('marca "respondida" (legada, ainda não reconciliada) NÃO ativa o veto — segue fechando como antes', async () => {
    const { d, fechadas } = deps({
      linhas: [linha({ issueNumber: 46, answeredHash: 'respondida:0:abc123' })],
    })
    const r = await executarCicloTerminal(d)
    expect(fechadas).toEqual([{ sessionName: 'sessions/x', motivo: 'dev-concluiu-sem-entrega' }])
    expect(r.issuesRedelegadas).toEqual([46])
  })

  it('uma que falha ao fechar não impede as outras', async () => {
    const linhas = [
      linha({ sessionName: 'sessions/a', issueNumber: 1 }),
      linha({ sessionName: 'sessions/b', issueNumber: 2 }),
    ]
    const { d, fechadas } = deps({ linhas })
    const original = d.fecharSessao
    d.fecharSessao = vi.fn(async (args) => {
      if (args.linha.sessionName === 'sessions/a') throw new Error('boom')
      return original(args)
    })
    await executarCicloTerminal(d)
    expect(fechadas.map((f) => f.sessionName)).toEqual(['sessions/b'])
  })

  // ── L4-T5: retomada no MESMO PR ───────────────────────────────────────────
  describe('retomada no mesmo PR (L4-T5)', () => {
    it('PR reprovado + ramo retomável → fecha a linha antiga e chama retomarNoMesmoPr', async () => {
      const linhas = [linha({ issueNumber: 3884, pullRequestNumber: 3917 })]
      const { d, fechadas } = deps({ linhas, pr: 'aberto-rejeitado-parado' })
      d.agora = new Date('2026-09-02T12:00:00Z') // 12h depois de lastProgressAt de linha()
      d.branchRetomavel = async () => 'jules-3917-branch'
      const retomadas: Array<{ issueNumber: number; numeroDoPr: number; branchDoPr: string }> = []
      d.retomarNoMesmoPr = async ({ linha: l, numeroDoPr, branchDoPr }) => {
        retomadas.push({ issueNumber: l.issueNumber, numeroDoPr, branchDoPr })
      }
      const r = await executarCicloTerminal(d)
      expect(fechadas).toEqual([{ sessionName: 'sessions/x', motivo: 'pr-rejeitado-sem-retomada' }])
      expect(retomadas).toEqual([
        { issueNumber: 3884, numeroDoPr: 3917, branchDoPr: 'jules-3917-branch' },
      ])
      expect(r.issuesRetomadasNoPr).toEqual([3884])
      // NÃO conta como redelegada — a issue não volta para a fila, ela
      // continua sendo trabalhada, só que numa sessão nova.
      expect(r.issuesRedelegadas).toEqual([])
    })

    it('sem branchRetomavel injetado → comportamento antigo (fecha e redelega)', async () => {
      const linhas = [linha({ issueNumber: 3884, pullRequestNumber: 3917 })]
      const { d, fechadas } = deps({ linhas, pr: 'aberto-rejeitado-parado' })
      d.agora = new Date('2026-09-02T12:00:00Z')
      const r = await executarCicloTerminal(d)
      expect(fechadas).toEqual([{ sessionName: 'sessions/x', motivo: 'pr-rejeitado-sem-retomada' }])
      expect(r.issuesRedelegadas).toEqual([3884])
      expect(r.issuesRetomadasNoPr).toEqual([])
    })

    it('branchRetomavel devolve null → cai no comportamento antigo', async () => {
      const linhas = [linha({ issueNumber: 3884, pullRequestNumber: 3917 })]
      const { d } = deps({ linhas, pr: 'aberto-rejeitado-parado' })
      d.agora = new Date('2026-09-02T12:00:00Z')
      d.branchRetomavel = async () => null
      const retomarNoMesmoPr = vi.fn(async () => undefined)
      d.retomarNoMesmoPr = retomarNoMesmoPr
      const r = await executarCicloTerminal(d)
      expect(retomarNoMesmoPr).not.toHaveBeenCalled()
      expect(r.issuesRedelegadas).toEqual([3884])
    })

    it('retomarNoMesmoPr falha → não impede as outras linhas do ciclo', async () => {
      const linhas = [
        linha({ sessionName: 'sessions/a', issueNumber: 1, pullRequestNumber: 10 }),
        linha({ sessionName: 'sessions/b', issueNumber: 2 }),
      ]
      const { d, fechadas } = deps({ linhas, pr: 'aberto-rejeitado-parado' })
      d.agora = new Date('2026-09-02T12:00:00Z')
      d.branchRetomavel = async () => 'branch-x'
      d.retomarNoMesmoPr = async () => {
        throw new Error('boom')
      }
      const r = await executarCicloTerminal(d)
      // a de #2 (sem PR, situação sem-pr) segue seu caminho normal
      expect(fechadas.map((f) => f.sessionName)).toContain('sessions/b')
      expect(r.issuesRetomadasNoPr).toEqual([])
    })

    it('ainda dentro das 12h → mantém, nem chega a olhar o ramo', async () => {
      const linhas = [linha({ issueNumber: 3884, pullRequestNumber: 3917 })]
      const { d, fechadas } = deps({ linhas, pr: 'aberto-rejeitado-parado' })
      d.agora = new Date('2026-08-28T06:00:00Z') // poucas horas depois
      const branchRetomavel = vi.fn(async () => 'branch-x')
      d.branchRetomavel = branchRetomavel
      const r = await executarCicloTerminal(d)
      expect(fechadas).toEqual([])
      expect(r.mantidas).toBe(1)
      expect(branchRetomavel).not.toHaveBeenCalled()
    })
  })
})
