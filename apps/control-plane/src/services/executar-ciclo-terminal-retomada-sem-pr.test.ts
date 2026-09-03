import { describe, it, expect, vi } from 'vitest'
import type { LinhaParaCicloTerminal } from './dev-session-store.js'

// C4 (fix-up L4-T5, CSO): `executar-ciclo-terminal.ts` fazia
// `linha.pullRequestNumber as number` na branch `retomar-no-mesmo-pr` — um
// type assertion que NÃO valida nada em runtime. Hoje é inalcançável pela
// combinação real de deps (o chamador só popula `branchRetomavel` quando
// `linha.pullRequestNumber !== null`), mas é defesa em profundidade: se
// `situacaoDoPr`/`branchRetomavel` (dependências INJETADAS, não puras)
// devolverem uma combinação inconsistente — `aberto-rejeitado-parado` com
// ramo retomável mas SEM número de PR —, o cast antigo passaria `null`
// digitado como `number` adiante (para `retomarNoMesmoPr`), que faria
// chamadas ao GitHub/Jules com um PR inexistente.
//
// Este teste força exatamente essa combinação inconsistente via
// `vi.mock('./sessao-terminal.js')` — a única forma de fazer
// `decidirSessaoTerminal` devolver `retomar-no-mesmo-pr` sem que o guard de
// `linha.pullRequestNumber !== null` (que já existe ANTES de chamar
// `branchRetomavel`) barre o cenário mais cedo.
vi.mock('./sessao-terminal.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sessao-terminal.js')>()
  return {
    ...real,
    decidirSessaoTerminal: vi.fn(() => ({
      acao: 'retomar-no-mesmo-pr' as const,
      branchDoPr: 'branch-fantasma',
    })),
  }
})

describe('executarCicloTerminal — C4: retomar-no-mesmo-pr sem pullRequestNumber', () => {
  it('linha.pullRequestNumber null → NUNCA chama retomarNoMesmoPr, avisa e mantém a linha', async () => {
    const { executarCicloTerminal } = await import('./executar-ciclo-terminal.js')

    const linha: LinhaParaCicloTerminal = {
      sessionName: 'sessions/fantasma',
      projectId: 'p1',
      issueNumber: 999,
      state: 'COMPLETED',
      pullRequestNumber: null, // decisão diz "retomar-no-mesmo-pr" mesmo assim (mock acima)
      lastProgressAt: new Date('2026-08-01T00:00:00Z'),
      requeueCount: 0,
      analysisDoneAt: null,
      devAccountId: null,
      answeredHash: null,
    }

    const avisos: string[] = []
    const retomarNoMesmoPr = vi.fn(async () => undefined)
    const fecharSessao = vi.fn(async () => undefined)

    const r = await executarCicloTerminal({
      listarLinhas: async () => [linha],
      situacaoDoPr: async () => 'aberto-rejeitado-parado',
      branchRetomavel: async () => 'branch-fantasma',
      retomarNoMesmoPr,
      fecharSessao,
      pedirAnalise: async () => undefined,
      agora: new Date('2026-08-02T00:00:00Z'),
      onWarn: (m) => avisos.push(m),
    })

    expect(retomarNoMesmoPr).not.toHaveBeenCalled()
    expect(fecharSessao).not.toHaveBeenCalled()
    expect(r.mantidas).toBe(1)
    expect(r.issuesRetomadasNoPr).toEqual([])
    expect(avisos.some((m) => m.includes('#999'))).toBe(true)
  })
})
