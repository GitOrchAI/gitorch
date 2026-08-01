import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { pipelineCheckEnabled } from './pipeline-check.js'
import { schedulerPlugin } from '../plugins/scheduler.js'

describe('pipelineCheckEnabled', () => {
  it('liga só com "1"', () => {
    expect(pipelineCheckEnabled({ GITORCH_PIPELINE_CHECK: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(pipelineCheckEnabled({ GITORCH_PIPELINE_CHECK: 'true' } as NodeJS.ProcessEnv)).toBe(
      false
    )
    expect(pipelineCheckEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('scheduler em modo pipeline-check', () => {
  it('registra sem tocar prisma/engineConnections e o trigger recusa com reason clara', async () => {
    process.env['GITORCH_PIPELINE_CHECK'] = '1'
    try {
      // App PELADA: sem prisma, sem engineConnections, sem cortex. Se o guard
      // não vier ANTES de buildMissionRunner/buildRuntimeStack, isto explode.
      const app = Fastify({ logger: false })
      await app.register(schedulerPlugin)
      const res = await app.triggerAgentMission('po')
      expect(res).toEqual({ triggered: false, reason: 'pipeline-check' })
      await app.close()
    } finally {
      delete process.env['GITORCH_PIPELINE_CHECK']
    }
  })
})
