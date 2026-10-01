import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeGitAction } from './actor.js'

describe('GitActor', () => {
  let octokitMock: unknown

  beforeEach(() => {
    octokitMock = {
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha-123' } } }),
          createRef: vi.fn().mockResolvedValue({}),
        },
        repos: {
          getContent: vi.fn().mockRejectedValue({ status: 404 }), // mock not found initially
          createOrUpdateFileContents: vi.fn().mockResolvedValue({}),
        },
        pulls: {
          create: vi.fn().mockResolvedValue({
            data: { number: 42, html_url: 'https://github.com/owner/repo/pull/42' },
          }),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
        },
      },
    }
  })

  it('should not mutate repository when autonomy is so_olhar', async () => {
    const result = await executeGitAction({
      octokit: octokitMock,
      owner: 'owner',
      repo: 'repo',
      autonomy: 'so_olhar',
      optimizedYaml: 'test',
      assessment: {},
    })

    expect(result.action).toBe('observed')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.git.getRef).not.toHaveBeenCalled()
  })

  it('should create branch and PR when autonomy is sugerir', async () => {
    const result = await executeGitAction({
      octokit: octokitMock,
      owner: 'owner',
      repo: 'repo',
      autonomy: 'sugerir',
      optimizedYaml: 'new-yaml-content',
      assessment: {
        scoreAntes: 50,
        scoreDepois: 90,
        capacidadesAdicionadas: ['SAST', 'Secret Scan'],
      },
      branchName: 'ci/test-branch',
    })

    expect(result.action).toBe('pr_created')
    expect(result.branch).toBe('ci/test-branch')
    expect(result.prNumber).toBe(42)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.git.getRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'heads/main',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.git.createRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'refs/heads/ci/test-branch',
      sha: 'base-sha-123',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      path: '.github/workflows/ci.yml',
      message: 'ci: otimizar esteira de CI/CD e mitigar riscos de segurança',
      content: Buffer.from('new-yaml-content').toString('base64'),
      branch: 'ci/test-branch',
      sha: undefined,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.pulls.create).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createPrCall = (octokitMock as any).rest.pulls.create.mock.calls[0][0]
    expect(createPrCall.title).toBe('ci: otimizar esteira de CI/CD e mitigar riscos de segurança')
    expect(createPrCall.body).toContain('Score antes: 50')
    expect(createPrCall.body).toContain('Score depois: 90')
    expect(createPrCall.body).toContain('- SAST')
    expect(createPrCall.body).toContain('- Secret Scan')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.issues.addLabels).not.toHaveBeenCalled()
  })

  it('should create PR and automerge when autonomy is cuidar', async () => {
    const result = await executeGitAction({
      octokit: octokitMock,
      owner: 'owner',
      repo: 'repo',
      autonomy: 'cuidar',
      optimizedYaml: 'new-yaml-content',
      assessment: {},
      branchName: 'ci/test-branch',
    })

    expect(result.action).toBe('pr_created_with_automerge')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.pulls.create).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((octokitMock as any).rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      labels: ['auto-merge'],
    })
  })
})
