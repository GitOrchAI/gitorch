import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  makeAntigravityDiscoverer,
  makeCodexDiscoverer,
  makeClaudeModelDiscoverer,
  defaultCodexWarmUp,
} from './model-catalog.js'
import { codexQuotaFilePath } from './quota-reader.js'

describe('model-catalog', () => {
  test('antigravity: uma linha por modelo', async () => {
    const discover = makeAntigravityDiscoverer(
      'agy',
      async () => 'Gemini 3.5 Flash\n Claude Opus \n\n'
    )
    expect(await discover('/tmp/x')).toEqual(['Gemini 3.5 Flash', 'Claude Opus'])
  })

  // O `agy models` REAL imprime `slug<TAB>Nome de Exibição` — conferido nesta
  // VM em 31/08/2026 com `agy models | cat -A`. O fake acima nunca teve TAB,
  // então o coletor guardava a string COLADA e o teste passava mesmo assim:
  // medido no banco, engine_connections.models do antigravity tinha 14 entradas
  // no formato 'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)'. Nenhuma
  // delas serviria como valor de --model, que aceita o NOME DE EXIBIÇÃO
  // (provado: `agy --model "Gemini 3.5 Flash (Medium)"` -> "invalid model
  // selection ... Available models: Gemini 3.7 Flash (High) ...").
  test('antigravity: a saída REAL tem TAB, e só o nome de exibição serve', async () => {
    const saidaReal =
      'Fetching available models...\n' +
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n' +
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n'
    const discover = makeAntigravityDiscoverer('agy', async () => saidaReal)
    const modelos = await discover('/tmp/x')
    expect(modelos).toContain('Gemini 3.7 Flash (Medium)')
    expect(modelos).toContain('Gemini 3.1 Pro (Low)')
    expect(modelos.some((m) => m.includes('\t'))).toBe(false)
    // A linha de status do CLI não é modelo nenhum.
    expect(modelos).not.toContain('Fetching available models...')
  })

  test('codex: lê models_cache.json (display_name ou slug)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(
      path.join(home, '.codex', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }, { slug: 'o4' }] })
    )
    // Aquecimento FAKE de propósito: desde que a coleta de cota passou a
    // disparar o aquecimento periodicamente, este HOME (sem arquivo de cota)
    // faria o discoverer real tentar subir o binário `codex` — que não existe
    // em CI e travaria o teste. O que este teste mede é a LEITURA do cache.
    const discover = makeCodexDiscoverer('codex-fake-bin', async () => undefined)
    expect(await discover(home)).toEqual(['GPT-5.5', 'o4'])
    await fs.rm(home, { recursive: true, force: true })
  })

  // A CAUSA da cota sempre nula (medida em produção 27/08): o aquecimento era
  // disparado só quando `models_cache.json` estava AUSENTE — e esse arquivo
  // vive no cofre e volta a cada missão, então nunca estava ausente. O
  // aquecimento nunca rodava e o arquivo de cota nunca era escrito.
  describe('codex: a cota também dispara o aquecimento', () => {
    test('cache PRESENTE mas cota nunca coletada -> aquece assim mesmo', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-cota-'))
      await fs.mkdir(path.join(home, '.codex'), { recursive: true })
      await fs.writeFile(
        path.join(home, '.codex', 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })
      )
      let aqueceu = 0
      const discover = makeCodexDiscoverer('codex-fake-bin', async () => {
        aqueceu++
      })
      expect(await discover(home)).toEqual(['gpt-5.5'])
      expect(aqueceu).toBe(1)
      await fs.rm(home, { recursive: true, force: true })
    })

    test('cota coletada agora há pouco -> NÃO aquece (não queima a cota do cliente)', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-cota-nova-'))
      await fs.mkdir(path.join(home, '.codex'), { recursive: true })
      await fs.writeFile(
        path.join(home, '.codex', 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })
      )
      await fs.writeFile(path.join(home, '.codex', 'gitorch-quota.json'), '{}')
      let aqueceu = 0
      const discover = makeCodexDiscoverer('codex-fake-bin', async () => {
        aqueceu++
      })
      expect(await discover(home)).toEqual(['gpt-5.5'])
      expect(aqueceu).toBe(0)
      await fs.rm(home, { recursive: true, force: true })
    })
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

  // `GET /v1/models` da API pública da Anthropic, autenticado com o token que
  // `claude setup-token` gera (o mesmo do homeDir — ver claude-token.ts).
  // `fetch` é injetado (nunca bate rede real no teste); `readToken` também,
  // pra não depender de um homeDir de verdade.
  //
  // SEM lista fixa de reserva: uma falha de leitura real tem que LANÇAR, não
  // devolver uma lista hardcode com cara de catálogo vivo — foi essa troca
  // silenciosa que fazia o chamador (refreshModels) gravar a lista fixa como
  // se fosse coleta bem-sucedida, sobrescrevendo um catálogo real anterior.
  describe('makeClaudeModelDiscoverer (API real, fetch/token fake)', () => {
    const original = process.env['GITORCH_CLAUDE_MODELS']
    beforeEach(() => delete process.env['GITORCH_CLAUDE_MODELS'])
    afterEach(() => {
      if (original === undefined) delete process.env['GITORCH_CLAUDE_MODELS']
      else process.env['GITORCH_CLAUDE_MODELS'] = original
    })

    test('sem token no homeDir -> lança erro explícito, nunca chama fetch, nunca inventa lista', async () => {
      const fetchSpy = vi.fn()
      const discover = makeClaudeModelDiscoverer(fetchSpy, async () => null)
      await expect(discover('/tmp/gitorch-sem-token-xyz')).rejects.toThrow('sem token do Claude')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('com token -> GET /v1/models com os headers de auth certos, devolve display_name||id', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
            { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
            { id: 'claude-sem-display-name' },
          ],
        }),
      })
      const discover = makeClaudeModelDiscoverer(fetchSpy, async () => 'sk-ant-oat01-fake')
      const models = await discover('/home/x')
      expect(models).toEqual(['Claude Sonnet 5', 'Claude Opus 4.8', 'claude-sem-display-name'])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=20')
      expect(init.method).toBe('GET')
      expect(init.headers).toMatchObject({
        authorization: 'Bearer sk-ant-oat01-fake',
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      })
    })

    test('resposta não-ok (401/500) -> lança com o status, nunca inventa lista', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 })
      const discover = makeClaudeModelDiscoverer(fetchSpy, async () => 'sk-ant-oat01-fake')
      await expect(discover('/home/x')).rejects.toThrow('401')
    })

    test('fetch rejeita (rede fora/timeout) -> lança com o motivo real, nunca inventa lista', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'))
      const discover = makeClaudeModelDiscoverer(fetchSpy, async () => 'sk-ant-oat01-fake')
      await expect(discover('/home/x')).rejects.toThrow('network down')
    })

    test('JSON sem data / lista vazia -> lança, nunca inventa lista', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
      const discover = makeClaudeModelDiscoverer(fetchSpy, async () => 'sk-ant-oat01-fake')
      await expect(discover('/home/x')).rejects.toThrow('vazio')
    })

    test('GITORCH_CLAUDE_MODELS vence tudo — nunca lê token nem chama fetch', async () => {
      process.env['GITORCH_CLAUDE_MODELS'] = 'model-a, model-b'
      const fetchSpy = vi.fn()
      const readToken = vi.fn()
      const discover = makeClaudeModelDiscoverer(fetchSpy, readToken)
      expect(await discover('/home/x')).toEqual(['model-a', 'model-b'])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(readToken).not.toHaveBeenCalled()
    })

    test('erro nunca carrega o valor do token na mensagem', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'))
      const discover = makeClaudeModelDiscoverer(fetchSpy, async () => 'sk-ant-oat01-SEGREDO')
      let mensagem = ''
      try {
        await discover('/home/x')
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err)
      }
      expect(mensagem).not.toContain('SEGREDO')
    })
  })
})

// Evento REAL observado ao vivo 21/07 (docs/operations/engine-collection-real-
// steps.md): plano free do dono, sem janela secundária (~5h).
const REAL_RATE_LIMITS_LINE =
  '{"allowed":true,"limit_reached":false,"primary":{"used_percent":7,"window_minutes":10080,"reset_after_seconds":482917,"reset_at":1785085248},"secondary":null}'

// `defaultCodexWarmUp` roda `codex exec --json` (UM ÚNICO exec — nunca dois)
// e usa o MESMO stdout pra alimentar tanto `models_cache.json` (o próprio
// CLI grava isso, fora do controle deste código) quanto
// `~/.codex/gitorch-quota.json` (este código grava, a partir do evento
// `rate_limits`). O runner é injetável (`CodexExecRunner`) — nenhum destes
// testes invoca o binário `codex` real.
describe('defaultCodexWarmUp (grava gitorch-quota.json a partir do stdout)', () => {
  async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codex-warmup-quota-'))
    try {
      await fn(home)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }

  test('runner emite o evento rate_limits -> grava gitorch-quota.json com os campos certos', async () => {
    await withTempHome(async (home) => {
      const runner = vi.fn().mockResolvedValue(REAL_RATE_LIMITS_LINE)
      await defaultCodexWarmUp('codex-fake-bin', home, runner)

      expect(runner).toHaveBeenCalledTimes(1)
      const raw = await fs.readFile(codexQuotaFilePath(home), 'utf8')
      expect(JSON.parse(raw)).toEqual({
        used_percent: 7,
        window_minutes: 10080,
        reset_at: 1785085248,
        secondary: null,
      })
    })
  })

  test('roda `codex exec --json` (uma vez só) com o bin e o HOME certos', async () => {
    await withTempHome(async (home) => {
      const runner = vi.fn().mockResolvedValue(REAL_RATE_LIMITS_LINE)
      await defaultCodexWarmUp('codex-fake-bin', home, runner)

      expect(runner).toHaveBeenCalledTimes(1)
      const [bin, args, env] = runner.mock.calls[0] as [string, string[], Record<string, string>]
      expect(bin).toBe('codex-fake-bin')
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      expect(env['HOME']).toBe(home)
      // RUST_LOG=trace é o que faz o evento `rate_limits` sair (no stderr, via
      // WebSocket) — sem isto a quota do Codex é sempre nula (bug do PR #363).
      expect(env['RUST_LOG']).toBe('trace')
    })
  })

  test('stdout sem o evento rate_limits -> grava arquivo com erro, não lança', async () => {
    await withTempHome(async (home) => {
      const runner = vi.fn().mockResolvedValue('{"type":"item.completed"}\n')
      await expect(defaultCodexWarmUp('codex-fake-bin', home, runner)).resolves.toBeUndefined()

      const raw = await fs.readFile(codexQuotaFilePath(home), 'utf8')
      expect(JSON.parse(raw).error_reason).toBe('CLI não expôs métricas de cota no output JSON')
    })
  })

  test('runner (o exec) falha -> warmUp propaga o erro, grava arquivo com erro', async () => {
    await withTempHome(async (home) => {
      const runner = vi.fn().mockRejectedValue(new Error('timeout: provider não respondeu'))
      await expect(defaultCodexWarmUp('codex-fake-bin', home, runner)).rejects.toThrow(
        'timeout: provider não respondeu'
      )
      const raw = await fs.readFile(codexQuotaFilePath(home), 'utf8')
      expect(JSON.parse(raw).error_reason).toBe('Erro de execução: timeout: provider não respondeu')
    })
  })

  test('runner falha com ENOENT -> grava CLI não instalado', async () => {
    await withTempHome(async (home) => {
      const error = new Error('spawn ENOENT')
      Object.assign(error, { code: 'ENOENT' })
      const runner = vi.fn().mockRejectedValue(error)
      await expect(defaultCodexWarmUp('codex-fake-bin', home, runner)).rejects.toThrow()

      const raw = await fs.readFile(codexQuotaFilePath(home), 'utf8')
      expect(JSON.parse(raw).error_reason).toBe('CLI não instalado')
    })
  })
})
