import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordPipelineEvidence } from './record-pipeline-evidence.js'

describe('Record Pipeline Evidence Helper', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue(mockEvidenceResponse),
    } as unknown as Response)

    const result = await recordPipelineEvidence({
      apiUrl: 'http://127.0.0.1:4012',
      projectId: 'proj_123',
      commitHash: 'commit_abc',
      branch: 'feat/test',
      status: 'passed',
      evidenceSummary: { coverage: 95 },
    })

    expect(result).toEqual(mockEvidenceResponse)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4012/api/v1/projects/proj_123/pipelines/evidence',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  it('should throw error when endpoint returns failure status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('PipelineConfig not found for project'),
    } as unknown as Response)

    await expect(
      recordPipelineEvidence({
        apiUrl: 'http://127.0.0.1:4012',
        projectId: 'proj_unknown',
      })
    ).rejects.toThrow('Failed to record pipeline evidence: HTTP 404')
  })
})
