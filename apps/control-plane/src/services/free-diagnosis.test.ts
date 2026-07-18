import { describe, it, expect, vi } from 'vitest'
import { processDiagnosisJob, repoWorkspaceSlug } from './free-diagnosis.js'
import type { StructuralDiagnosis } from '@gitorch/cgc'
import type { GithubSignals } from './github-signals.js'

function fakePrisma() {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  return {
    updates,
    diagnosisJob: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args)
        return args
      }),
    },
  }
}

const STRUCTURAL: StructuralDiagnosis = {
  fileCount: 5,
  indexedFiles: 5,
  symbolsByType: { function: 10 },
  largestFiles: [{ file: 'src/a.ts', symbolCount: 5 }],
  mostCalledFunctions: [],
  untestedModules: [],
  directoryInventory: { src: ['a.ts'] },
}
const SIGNALS: GithubSignals = {
  openIssues: 1,
  openPullRequests: 0,
  stalePullRequests: 0,
  ciHealth: 'passing',
}

describe('processDiagnosisJob', () => {
  it('caminho feliz: narra progresso em ordem e grava resultado completo (findings+score)', async () => {
    const prisma = fakePrisma()
    const provider = { allocateWorkspace: vi.fn(async () => ({ path: '/ws/repo' })) }
    const diagnose = vi.fn(async () => STRUCTURAL)
    const fetchSignals = vi.fn(async () => SIGNALS)

    await processDiagnosisJob(
      'job1',
      { userId: 'u1', repoFullName: 'acme/loja', githubToken: 'tok' },
      { prisma, workspaceProvider: provider, diagnose, fetchSignals }
    )

    const progressSeq = prisma.updates.map((u) => u.data['progress']).filter(Boolean)
    expect(progressSeq).toEqual(['cloning', 'indexing', 'reading_github', 'done'])

    const final = prisma.updates.at(-1)!
    expect(final.data['status']).toBe('completed')
    const result = final.data['result'] as { healthScore: number; findings: unknown[] }
    expect(result.healthScore).toBeGreaterThan(0)
    expect(Array.isArray(result.findings)).toBe(true)

    // clona com o token do usuário, num path determinístico por repo (F4 reusa depois)
    expect(provider.allocateWorkspace).toHaveBeenCalledWith('u1', repoWorkspaceSlug('acme/loja'), {
      repository: 'acme/loja',
      token: 'tok',
    })
  })

  it('reaproveita o clone do ambiente (existingWorkspacePath) — não clona 2x', async () => {
    const prisma = fakePrisma()
    const provider = { allocateWorkspace: vi.fn() }
    const diagnose = vi.fn(async () => STRUCTURAL)
    const fetchSignals = vi.fn(async () => SIGNALS)

    await processDiagnosisJob(
      'job-reuse',
      { userId: 'u1', repoFullName: 'acme/loja', githubToken: 'tok' },
      {
        prisma,
        workspaceProvider: provider,
        diagnose,
        fetchSignals,
        existingWorkspacePath: '/env/env_1/acme_loja',
      }
    )

    // não clona de novo; analisa o clone que já existe no ambiente (passo 4)
    expect(provider.allocateWorkspace).not.toHaveBeenCalled()
    expect(diagnose).toHaveBeenCalledWith('/env/env_1/acme_loja')
    expect(prisma.updates.at(-1)!.data['status']).toBe('completed')
  })

  it('repo sem código-fonte reconhecido: estado HONESTO (empty), não erro', async () => {
    const prisma = fakePrisma()
    const provider = { allocateWorkspace: vi.fn(async () => ({ path: '/ws/repo' })) }
    const diagnose = vi.fn(async () => undefined)
    const fetchSignals = vi.fn(async () => SIGNALS)

    await processDiagnosisJob(
      'job2',
      { userId: 'u1', repoFullName: 'acme/vazio', githubToken: 'tok' },
      { prisma, workspaceProvider: provider, diagnose, fetchSignals }
    )

    const final = prisma.updates.at(-1)!
    expect(final.data['status']).toBe('completed')
    const result = final.data['result'] as { empty: boolean }
    expect(result.empty).toBe(true)
  })

  it('clone falha: marca failed com o erro, nunca lança (chamador não precisa de try/catch)', async () => {
    const prisma = fakePrisma()
    const provider = {
      allocateWorkspace: vi.fn(async () => {
        throw new Error('clone: permission denied')
      }),
    }
    const diagnose = vi.fn()
    const fetchSignals = vi.fn()

    await expect(
      processDiagnosisJob(
        'job3',
        { userId: 'u1', repoFullName: 'acme/privado', githubToken: 'tok' },
        { prisma, workspaceProvider: provider, diagnose, fetchSignals }
      )
    ).resolves.toBeUndefined()

    const final = prisma.updates.at(-1)!
    expect(final.data['status']).toBe('failed')
    expect(final.data['error']).toContain('permission denied')
    expect(diagnose).not.toHaveBeenCalled()
  })

  it('falha de clone classificada grava "CODE: mensagem" no error (contrato de erro pro front)', async () => {
    const prisma = fakePrisma()
    const provider = {
      allocateWorkspace: vi.fn(async () => {
        throw new Error(
          'Command failed: git clone --depth 1 -- https://github.com/acme/sumiu.git /ws\n' +
            "Cloning into '/ws'...\n" +
            'remote: Repository not found.\n' +
            "fatal: repository 'https://github.com/acme/sumiu.git/' not found\n"
        )
      }),
    }
    const diagnose = vi.fn()
    const fetchSignals = vi.fn()

    await processDiagnosisJob(
      'job4',
      { userId: 'u1', repoFullName: 'acme/sumiu', githubToken: 'tok' },
      { prisma, workspaceProvider: provider, diagnose, fetchSignals }
    )

    const final = prisma.updates.at(-1)!
    expect(final.data['status']).toBe('failed')
    expect(final.data['error']).toMatch(/^REPO_NOT_FOUND: /)
  })

  it('timeout do clone (killed/signal) vira DIAG_TIMEOUT no error do job', async () => {
    const prisma = fakePrisma()
    const provider = {
      allocateWorkspace: vi.fn(async () => {
        throw Object.assign(new Error('Command failed: git clone ...\n'), {
          killed: true,
          signal: 'SIGTERM',
        })
      }),
    }
    const diagnose = vi.fn()
    const fetchSignals = vi.fn()

    await processDiagnosisJob(
      'job5',
      { userId: 'u1', repoFullName: 'acme/lento', githubToken: 'tok' },
      { prisma, workspaceProvider: provider, diagnose, fetchSignals }
    )

    const final = prisma.updates.at(-1)!
    expect(final.data['error']).toMatch(/^DIAG_TIMEOUT: /)
  })
})

describe('repoWorkspaceSlug', () => {
  it('é determinístico e seguro para path (mesmo repo -> mesmo slug)', () => {
    expect(repoWorkspaceSlug('acme/loja-antiga')).toBe(repoWorkspaceSlug('acme/loja-antiga'))
    expect(repoWorkspaceSlug('acme/loja')).not.toContain('/')
  })
})
