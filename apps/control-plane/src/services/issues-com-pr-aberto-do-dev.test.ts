import { describe, it, expect } from 'vitest'
import { issuesComPrAbertoDoDev } from './sm-delegation.js'
import type { LinhaDeSessao } from './dev-session-store.js'

// L4-T5: issue #3884 do Jardim, 5 sessões e 3 PRs (#3907, #3913, #3917) para
// UMA task — a sessão morre (`pr-rejeitado-sem-retomada`), solta a issue da
// fila, e nada olhava se o PR anterior ainda estava aberto. Este conjunto é o
// que `escolherParaDelegar` (fila-de-delegacao.ts) usa para não redelegar
// enquanto o PR do dev segue esperando conserto.

function linha(over: Partial<LinhaDeSessao>): LinhaDeSessao {
  return {
    id: 'x',
    projectId: 'p1',
    issueNumber: 1,
    sessionName: 's1',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
    ...over,
  }
}

function ghFake(prsAbertos: number[]) {
  const chamadas: string[] = []
  const gh = async (method: string, path: string): Promise<unknown> => {
    chamadas.push(`${method} ${path}`)
    if (/\/pulls\?state=open/.test(path)) {
      return prsAbertos.map((n) => ({ number: n }))
    }
    throw new Error(`chamada inesperada: ${method} ${path}`)
  }
  return { gh, chamadas }
}

describe('issuesComPrAbertoDoDev', () => {
  it('nenhuma sessão com PR → conjunto vazio, e NÃO chama o GitHub à toa', async () => {
    const { gh, chamadas } = ghFake([])
    const r = await issuesComPrAbertoDoDev({
      repository: 'o/r',
      gh,
      sessoes: [linha({ issueNumber: 1, pullRequestNumber: null })],
    })
    expect(r).toEqual(new Set())
    expect(chamadas).toEqual([])
  })

  it('sessão fechada com PR ainda ABERTO → issue entra no conjunto', async () => {
    const { gh } = ghFake([3917])
    const r = await issuesComPrAbertoDoDev({
      repository: 'loureng/patinhas-3d-crafts',
      gh,
      sessoes: [
        linha({
          issueNumber: 3884,
          pullRequestNumber: 3917,
          state: 'COMPLETED',
          closedAt: new Date('2026-09-02T05:00:00Z'),
        }),
      ],
    })
    expect(r).toEqual(new Set([3884]))
  })

  it('PR já fechado/mesclado (não está mais na lista de abertos) → issue NÃO entra', async () => {
    const { gh } = ghFake([]) // nenhum PR aberto agora
    const r = await issuesComPrAbertoDoDev({
      repository: 'o/r',
      gh,
      sessoes: [linha({ issueNumber: 3884, pullRequestNumber: 3907 })],
    })
    expect(r).toEqual(new Set())
  })

  it('várias sessões da mesma issue com PRs diferentes: entra se QUALQUER um está aberto', async () => {
    const { gh } = ghFake([3917])
    const r = await issuesComPrAbertoDoDev({
      repository: 'o/r',
      gh,
      sessoes: [
        linha({ issueNumber: 3884, pullRequestNumber: 3907, closedAt: new Date() }),
        linha({ issueNumber: 3884, pullRequestNumber: 3913, closedAt: new Date() }),
        linha({ issueNumber: 3884, pullRequestNumber: 3917, closedAt: null }),
      ],
    })
    expect(r).toEqual(new Set([3884]))
  })

  it('issues diferentes, cada uma com o próprio PR aberto', async () => {
    const { gh } = ghFake([10, 20])
    const r = await issuesComPrAbertoDoDev({
      repository: 'o/r',
      gh,
      sessoes: [
        linha({ issueNumber: 1, pullRequestNumber: 10 }),
        linha({ issueNumber: 2, pullRequestNumber: 20 }),
        linha({ issueNumber: 3, pullRequestNumber: 30 }),
      ],
    })
    expect(r).toEqual(new Set([1, 2]))
  })

  it('UMA chamada só ao GitHub, mesmo com várias sessões com PR', async () => {
    const { gh, chamadas } = ghFake([1, 2, 3])
    await issuesComPrAbertoDoDev({
      repository: 'o/r',
      gh,
      sessoes: [
        linha({ issueNumber: 1, pullRequestNumber: 1 }),
        linha({ issueNumber: 2, pullRequestNumber: 2 }),
        linha({ issueNumber: 3, pullRequestNumber: 3 }),
      ],
    })
    expect(chamadas).toHaveLength(1)
  })
})
