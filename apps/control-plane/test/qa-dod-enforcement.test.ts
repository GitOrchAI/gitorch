import { describe, it, expect, vi } from 'vitest'
import { runQaMissionViaRails } from '../src/services/qa-rails-mission.js'
import type { PrismaClient } from '@prisma/client'

function buildMockFetch(prDiffFiles: { filename: string; patch: string }[], issueBody: string) {
  return async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
    if (u.includes('/pulls?')) {
      return json([{ number: 881, user: { login: 'google-labs-jules[bot]' }, body: 'Closes #1' }])
    }
    if (u.includes('/pulls/881/reviews') && init?.method === 'GET') return json([])
    if (u.includes('/pulls/881/files')) {
      const page = new URL(u).searchParams.get('page')
      if (page !== '1') return json([])
      return json(prDiffFiles)
    }
    if (u.includes('/pulls/881')) {
      return json({ head: { sha: 'sha1' }, number: 881, user: { login: 'google-labs-jules[bot]' } })
    }
    if (u.includes('/issues/1/labels')) return json([])
    if (u.includes('/issues/1')) {
      return json({ body: issueBody, labels: [{ name: 'jules' }, { name: 'gitorch:task' }] })
    }
    if (u.includes('/commits/sha1/check-runs')) {
      return json({ check_runs: [{ name: 'ci', conclusion: 'success', status: 'completed' }] })
    }
    if (init?.method === 'POST') return json({ id: 1 })
    return json({})
  }
}

describe('QA DoD Enforcement (Issue #885)', () => {
  it('Should reject PR with missing test file', async () => {
    const fetchMock = buildMockFetch(
      [{ filename: 'apps/control-plane/src/plugins/scheduler.ts', patch: '+ const a = 1' }],
      '## Verification Criteria\n- test coverage for PAUSED state'
    )

    let promptSent = ''
    await runQaMissionViaRails({
      prisma: {
        repoItem: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      } as unknown as PrismaClient,
      projectId: 'proj',
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchMock as unknown as typeof fetch,
      execute: async (prompt) => {
        promptSent = prompt
        return JSON.stringify({
          verdict: 'request_changes',
          comment: {
            titulo: 't',
            goal: 'g',
            taskDetails: 'd',
            taskDescription: 'd',
            implementationGuide: 'i',
            verificationCriteria: 'v',
            dependencies: 'd',
            relatedFiles: 'f',
            notes: 'missing test',
          },
          entendimento: {
            deOndeVeio: 'Jules solicitou ajuste longo e detalhado',
            oQueMuda: 'adiciona validação de algo',
            queAjusteE: 'feature importante para testes longos',
            porQueExiste: 'porque é necessário para funcionar',
          },
        })
      },
    })

    expect(promptSent).toContain('STRICT DEFINITION OF DONE')
    expect(promptSent).toContain('Compare the DoD STRICTLY with the REAL PR diff')
    expect(promptSent).toContain('If ANY required piece is missing')
  })

  it('Should reject PR that only modifies scripts folder without tests', async () => {
    const fetchMock = buildMockFetch(
      [
        {
          filename: 'apps/control-plane/scripts/aplicar-retrato-inicial.ts',
          patch: '+ const a = 1',
        },
      ],
      '## Verification Criteria\n- teste automatizado dos servicos'
    )
    let promptSent = ''
    await runQaMissionViaRails({
      prisma: {
        repoItem: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      } as unknown as PrismaClient,
      projectId: 'proj',
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchMock as unknown as typeof fetch,
      execute: async (prompt) => {
        promptSent = prompt
        return JSON.stringify({
          verdict: 'request_changes',
          comment: {
            titulo: 't',
            goal: 'g',
            taskDetails: 'd',
            taskDescription: 'd',
            implementationGuide: 'i',
            verificationCriteria: 'v',
            dependencies: 'd',
            relatedFiles: 'f',
            notes: 'n',
          },
          entendimento: {
            deOndeVeio: 'Jules solicitou ajuste longo e detalhado',
            oQueMuda: 'adiciona validação de algo',
            queAjusteE: 'feature importante para testes longos',
            porQueExiste: 'porque é necessário para funcionar',
          },
        })
      },
    })
    expect(promptSent).toContain(
      'If the PR ONLY modifies folders NOT covered by CI (like apps/control-plane/scripts) WITHOUT including tests'
    )
  })
})

describe('QA DoD Enforcement (Issue #885) - Schema only', () => {
  it('Should reject PR that only modifies schema when service test is requested', async () => {
    const fetchMock = buildMockFetch(
      [{ filename: 'apps/control-plane/prisma/schema.prisma', patch: '+ model A {}' }],
      '## Verification Criteria\n- servico+migracao+teste'
    )
    let promptSent = ''
    await runQaMissionViaRails({
      prisma: {
        repoItem: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      } as unknown as PrismaClient,
      projectId: 'proj',
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchMock as unknown as typeof fetch,
      execute: async (prompt) => {
        promptSent = prompt
        return JSON.stringify({
          verdict: 'request_changes',
          comment: {
            titulo: 't',
            goal: 'g',
            taskDetails: 'd',
            taskDescription: 'd',
            implementationGuide: 'i',
            verificationCriteria: 'v',
            dependencies: 'd',
            relatedFiles: 'f',
            notes: 'n',
          },
          entendimento: {
            deOndeVeio: 'Jules solicitou ajuste longo e detalhado',
            oQueMuda: 'adiciona validação de algo',
            queAjusteE: 'feature importante para testes longos',
            porQueExiste: 'porque é necessário para funcionar',
          },
        })
      },
    })
    expect(promptSent).toContain('If ANY required piece is missing')
  })
})

describe('QA DoD Enforcement (Issue #885) - Approve case', () => {
  it('Should approve PR when all DoD pieces are present', async () => {
    const fetchMock = buildMockFetch(
      [
        { filename: 'apps/control-plane/src/plugins/scheduler.ts', patch: '+ const a = 1' },
        { filename: 'apps/control-plane/src/plugins/scheduler.test.ts', patch: '+ test("PAUSED")' },
      ],
      '## Verification Criteria\n- test coverage for PAUSED state'
    )
    let promptSent = ''
    await runQaMissionViaRails({
      prisma: {
        repoItem: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      } as unknown as PrismaClient,
      projectId: 'proj',
      repository: 'o/r',
      githubToken: 't',
      fetchImpl: fetchMock as unknown as typeof fetch,
      execute: async (prompt) => {
        promptSent = prompt
        return JSON.stringify({
          verdict: 'approve',
          comment: {
            titulo: 't',
            goal: 'g',
            taskDetails: 'd',
            taskDescription: 'd',
            implementationGuide: 'i',
            verificationCriteria: 'v',
            dependencies: 'd',
            relatedFiles: 'f',
            notes: 'all good',
          },
          entendimento: {
            deOndeVeio: 'Jules solicitou ajuste longo e detalhado',
            oQueMuda: 'adiciona validação de algo',
            queAjusteE: 'feature importante para testes longos',
            porQueExiste: 'porque é necessário para funcionar',
          },
        })
      },
    })
    expect(promptSent).toContain('Compare the DoD STRICTLY with the REAL PR diff')
  })
})
