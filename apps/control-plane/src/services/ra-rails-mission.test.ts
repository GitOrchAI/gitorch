import { describe, it, expect } from 'vitest'
import { runRaMissionViaRails } from './ra-rails-mission.js'

const RA_REPLIES: Record<string, string> = {
  areas: JSON.stringify({
    areas: [
      {
        area: 'frontend',
        whatExistsToday: 'x',
        whatTheWishNeedsHere: 'y',
        filesToRead: ['src/a.tsx'],
      },
    ],
  }),
  journeys: JSON.stringify({
    journeys: [
      { title: 'J1', actor: 'user', steps: ['1', '2', '3'], insight: 'i1' },
      { title: 'J2', actor: 'system', steps: ['1', '2', '3'], insight: 'i2' },
    ],
  }),
  brief: JSON.stringify({
    whatThisProjectIs: 'p',
    architectureAndStack: 's',
    topRisks: ['r'],
    improvementOpportunities: ['o'],
    openQuestionsForPo: ['q'],
  }),
}

function executeFor(prompts: string[]) {
  return async (p: string) => {
    prompts.push(p)
    return RA_REPLIES[p.match(/Step: ra-(\w+)/)?.[1] ?? '?'] ?? '{}'
  }
}

describe('runRaMissionViaRails', () => {
  it('ancora a análise na wish ABERTA (todos os passos veem a wish)', async () => {
    const f = (async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('labels=wishlist')) {
        return new Response(
          JSON.stringify([
            { number: 77, title: 'Avaliações com estrelas', body: 'só quem comprou' },
          ]),
          { status: 200 }
        )
      }
      return new Response('[]', { status: 200 })
    }) as typeof fetch
    const prompts: string[] = []
    const r = await runRaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: executeFor(prompts),
      contextBlocks: ['codegraph'],
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(prompts).toHaveLength(3)
    for (const p of prompts) {
      expect(p).toContain('#77 Avaliações com estrelas')
      expect(p).toContain('not on past work')
    }
  })

  it('sem wish aberta: roda como scout geral (sem bloco de wish)', async () => {
    const f = (async () => new Response('[]', { status: 200 })) as typeof fetch
    const prompts: string[] = []
    const r = await runRaMissionViaRails({
      repository: 'o/r',
      githubToken: 't',
      execute: executeFor(prompts),
      contextBlocks: ['codegraph'],
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(prompts[0]).not.toContain('Wish under analysis')
  })

  it('sem token: não tenta o GitHub e segue', async () => {
    const prompts: string[] = []
    const r = await runRaMissionViaRails({
      repository: 'o/r',
      githubToken: undefined,
      execute: executeFor(prompts),
      contextBlocks: [],
    })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('RA analysis')
  })
})
