import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  knownClaudeModels,
  discoverCodexModels,
  makeAntigravityDiscoverer,
  makeCodexDiscoverer,
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

  // Regressão do bug real (2026-07-20): `codex login`/`codex login status` NÃO
  // gera models_cache.json — só uma sessão real (`codex exec`) gera. A
  // liveness passava (login ok) mas o catálogo vinha 0. Estes testes cobrem o
  // aquecimento com um FAKE runner (nunca invocam o binário `codex` real —
  // isso quebraria em CI, onde ele não existe, e seria lento/instável mesmo
  // nesta VM de dev).
  describe('codex: aquecimento do cache ausente', () => {
    test('cache ausente + aquecimento funciona -> lê os modelos recém-gravados', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-warmup-ok-'))
      let warmUpCalls = 0
      const discover = makeCodexDiscoverer('codex-fake-bin', async (bin, warmHome) => {
        warmUpCalls++
        expect(bin).toBe('codex-fake-bin')
        expect(warmHome).toBe(home)
        // Simula o que `codex exec` faz de verdade: grava o cache no HOME.
        await fs.mkdir(path.join(warmHome, '.codex'), { recursive: true })
        await fs.writeFile(
          path.join(warmHome, '.codex', 'models_cache.json'),
          JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] })
        )
      })

      expect(await discover(home)).toEqual(['GPT-5.5'])
      expect(warmUpCalls).toBe(1)

      await fs.rm(home, { recursive: true, force: true })
    })

    test('cache já existe -> NÃO aquece de novo (warm-up nunca chamado)', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-warmup-skip-'))
      await fs.mkdir(path.join(home, '.codex'), { recursive: true })
      await fs.writeFile(
        path.join(home, '.codex', 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'o4' }] })
      )
      const discover = makeCodexDiscoverer('codex-fake-bin', async () => {
        throw new Error('warm-up não deveria ter sido chamado: cache já existia')
      })

      expect(await discover(home)).toEqual(['o4'])

      await fs.rm(home, { recursive: true, force: true })
    })

    test('aquecimento falha -> lista vazia, sem lançar (connect não quebra)', async () => {
      const discover = makeCodexDiscoverer('codex-fake-bin', async () => {
        throw new Error('provider indisponível neste teste')
      })
      await expect(discover('/tmp/gitorch-codex-warmup-falha-xyz')).resolves.toEqual([])
    })

    // Achado 21/07: o dono viu "conectado, 0 modelos" e não havia NENHUM log
    // pra investigar o porquê — o catch antigo engolia o erro em silêncio.
    test('aquecimento falha -> loga a causa real (nunca mais silêncio)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const discover = makeCodexDiscoverer('codex-fake-bin', async () => {
        throw new Error('timeout: provider não respondeu')
      })

      await discover('/tmp/gitorch-codex-warmup-falha-log-xyz')

      expect(warnSpy).toHaveBeenCalledWith(
        '[model-catalog] aquecimento do Codex falhou — 0 modelos',
        expect.objectContaining({ error: 'timeout: provider não respondeu' })
      )
      warnSpy.mockRestore()
    })
  })

  test('codex: lista vazia quando não há cache e o aquecimento não roda (binário ausente)', async () => {
    // Usa um binário que certamente não existe no PATH — prova o fallback
    // honesto (nunca invoca o `codex` real do ambiente de teste).
    const discover = makeCodexDiscoverer('codex-binario-que-nao-existe-xyz')
    expect(await discover('/tmp/gitorch-inexistente-xyz')).toEqual([])
  })

  // Renomeado de `discoverClaudeModels` (20/07): o nome antigo mentia — a CLI
  // do Claude não tem NENHUM comando de listagem (verificado), então isto
  // nunca "descobre" nada; é a lista CONHECIDA de modelos reais disponíveis
  // hoje, a melhor fonte possível (não é dívida técnica).
  describe('knownClaudeModels', () => {
    const original = process.env['GITORCH_CLAUDE_MODELS']
    beforeEach(() => delete process.env['GITORCH_CLAUDE_MODELS'])
    afterEach(() => {
      if (original === undefined) delete process.env['GITORCH_CLAUDE_MODELS']
      else process.env['GITORCH_CLAUDE_MODELS'] = original
    })

    test('usa a lista conhecida por padrão', async () => {
      const models = await knownClaudeModels('/tmp')
      expect(models).toContain('claude-fable-5')
    })

    test('sobrescreve por ambiente', async () => {
      process.env['GITORCH_CLAUDE_MODELS'] = 'model-a, model-b'
      expect(await knownClaudeModels('/tmp')).toEqual(['model-a', 'model-b'])
    })
  })
})
