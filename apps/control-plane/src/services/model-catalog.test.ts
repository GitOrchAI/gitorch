import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  discoverClaudeModels,
  discoverCodexModels,
  makeAntigravityDiscoverer,
} from './model-catalog.js'

describe('model-catalog', () => {
  test('antigravity: uma linha por modelo', async () => {
    const discover = makeAntigravityDiscoverer(
      'agy',
      async () => 'Gemini 3.5 Flash\n Claude Opus \n\n'
    )
    expect(await discover('/tmp/x')).toEqual(['Gemini 3.5 Flash', 'Claude Opus'])
  })

  test('codex: lê models_cache.json (display_name ou slug)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(
      path.join(home, '.codex', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }, { slug: 'o4' }] })
    )
    expect(await discoverCodexModels(home)).toEqual(['GPT-5.5', 'o4'])
    await fs.rm(home, { recursive: true, force: true })
  })

  test('codex: lista vazia quando não há cache', async () => {
    expect(await discoverCodexModels('/tmp/gitorch-inexistente-xyz')).toEqual([])
  })

  describe('claude', () => {
    const original = process.env['GITORCH_CLAUDE_MODELS']
    beforeEach(() => delete process.env['GITORCH_CLAUDE_MODELS'])
    afterEach(() => {
      if (original === undefined) delete process.env['GITORCH_CLAUDE_MODELS']
      else process.env['GITORCH_CLAUDE_MODELS'] = original
    })

    test('usa a lista conhecida por padrão', async () => {
      const models = await discoverClaudeModels('/tmp')
      expect(models).toContain('claude-fable-5')
    })

    test('sobrescreve por ambiente', async () => {
      process.env['GITORCH_CLAUDE_MODELS'] = 'model-a, model-b'
      expect(await discoverClaudeModels('/tmp')).toEqual(['model-a', 'model-b'])
    })
  })
})
