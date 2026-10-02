import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordPipelineEvidence } from './record-pipeline-evidence.js'

describe('Record Pipeline Evidence Helper', () => {
  const originalFetch = globalThis.fetch
  const originalDbUrl = process.env.DATABASE_URL

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.DATABASE_URL
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalDbUrl !== undefined) {
      process.env.DATABASE_URL = originalDbUrl
    }
  })

  it('should post pipeline evidence to control-plane endpoint and return evidence record', async () => {
    const mockEvidenceResponse = {
      evidence: {
        id: 'ev_test_123',
        pipelineConfigId: 'cfg_123',
        commitHash: 'commit_abc',
        branch: 'feat/test',
        status: 'passed',
      },
    }

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/analyze')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ config: { id: 'cfg_123' } }),
        } as unknown as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockEvidenceResponse),
      } as unknown as Response)
    })

    const result = await recordPipelineEvidence({
      apiUrl: 'http://127.0.0.1:4012',
      projectId: 'proj_123',
      commitHash: 'commit_abc',
      branch: 'feat/test',
      status: 'passed',
      evidenceSummary: { coverage: 95 },
      token: 'test-token',
    })

    expect(result).toEqual(mockEvidenceResponse)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4012/api/v1/projects/proj_123/pipelines/evidence',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        }),
      })
    )
  })

  it('should throw error when endpoint returns failure status', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/analyze')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        } as unknown as Response)
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve('PipelineConfig not found for project'),
      } as unknown as Response)
    })

    await expect(
      recordPipelineEvidence({
        apiUrl: 'http://127.0.0.1:4012',
        projectId: 'proj_unknown',
      })
    ).rejects.toThrow('Failed to record pipeline evidence: HTTP 404')
  })
})
