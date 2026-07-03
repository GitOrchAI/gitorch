import { describe, expect, test } from 'vitest'
import Fastify from 'fastify'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { cortexPlugin } from './cortex.js'

describe('cortexPlugin', () => {
  test('grava a memória da missão isolada pelo wingId do projeto', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-cortex-'))
    process.env['GITORCH_CORTEX_DB'] = path.join(dir, 'cortex.sqlite')

    const app = Fastify()
    await app.register(cortexPlugin)
    await app.ready()

    await app.saveMissionMemory({
      wingId: 'owner-a/repo-a',
      missionId: 'm1',
      agentRole: 'ra',
      content: 'Brief do projeto A',
    })
    await app.saveMissionMemory({
      wingId: 'owner-b/repo-b',
      missionId: 'm2',
      agentRole: 'ra',
      content: 'Brief do projeto B',
    })

    const projectA = app.cortex.recallLocal('owner-a/repo-a')
    const projectB = app.cortex.recallLocal('owner-b/repo-b')

    expect(projectA.map((d) => d.content)).toEqual(['Brief do projeto A'])
    expect(projectB.map((d) => d.content)).toEqual(['Brief do projeto B'])
    // isolamento: a memória de A nunca aparece na consulta de B
    expect(projectB.some((d) => d.content.includes('projeto A'))).toBe(false)

    await app.close()
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env['GITORCH_CORTEX_DB']
  })
})
