import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GITORCH_HOST_PLUGIN_DISABLED_MESSAGE,
  buildHostPluginMissingMessage,
  isGitorchPluginPresentOnHost,
  resolveLocalPluginMarkerPath,
  wrapWithHostGitorchPluginGate,
} from './host-plugin-gate.js'
import type { RuntimeCommandRunner } from './runtime-adapter.js'

// Achado importante da revisão pós-merge: createPodmanCommandRunner (ver
// podman-runner.ts) só recusa uma missão sem o plugin de segurança quando
// GITORCH_EXECUTOR=podman. O DEFAULT do executor é 'local-process' — o que a
// CI usa — e nesse caminho não havia NENHUMA trava equivalente: a flag
// --dangerously-skip-permissions (fixa no código) rodava solta. Estes testes
// provam a mesma garantia do container, adaptada pro host.

describe('isGitorchPluginPresentOnHost', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitorch-host-plugin-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('marcador ausente: false', async () => {
    const marker = join(dir, 'nao-existe', 'hooks.json')
    expect(await isGitorchPluginPresentOnHost(marker)).toBe(false)
  })

  test('marcador presente: true', async () => {
    const pluginDir = join(dir, 'gitorch-plugin', 'gitorch')
    await mkdir(pluginDir, { recursive: true })
    const marker = join(pluginDir, 'hooks.json')
    await writeFile(marker, '{}')
    expect(await isGitorchPluginPresentOnHost(marker)).toBe(true)
  })
})

describe('resolveLocalPluginMarkerPath', () => {
  const originalMarkerEnv = process.env['GITORCH_LOCAL_PLUGIN_MARKER']

  afterEach(() => {
    if (originalMarkerEnv === undefined) delete process.env['GITORCH_LOCAL_PLUGIN_MARKER']
    else process.env['GITORCH_LOCAL_PLUGIN_MARKER'] = originalMarkerEnv
  })

  // Lido do env A CADA chamada (não congelado num `const` de módulo na
  // primeira importação) — senão um operador setando GITORCH_LOCAL_PLUGIN_MARKER
  // dependeria da ORDEM de import dos módulos pra fazer efeito.
  test('sem override explícito, lê GITORCH_LOCAL_PLUGIN_MARKER do env NO MOMENTO da chamada', () => {
    delete process.env['GITORCH_LOCAL_PLUGIN_MARKER']
    expect(resolveLocalPluginMarkerPath()).toBe('/opt/gitorch-plugin/gitorch/hooks.json')

    process.env['GITORCH_LOCAL_PLUGIN_MARKER'] = '/custom/marker.json'
    expect(resolveLocalPluginMarkerPath()).toBe('/custom/marker.json')
  })

  test('override explícito sempre vence o env', () => {
    process.env['GITORCH_LOCAL_PLUGIN_MARKER'] = '/custom/marker.json'
    expect(resolveLocalPluginMarkerPath('/explicito.json')).toBe('/explicito.json')
  })
})

describe('wrapWithHostGitorchPluginGate', () => {
  const originalPluginEnv = process.env['GITORCH_AGY_PLUGIN']
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitorch-host-plugin-wrap-'))
    delete process.env['GITORCH_AGY_PLUGIN']
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (originalPluginEnv === undefined) delete process.env['GITORCH_AGY_PLUGIN']
    else process.env['GITORCH_AGY_PLUGIN'] = originalPluginEnv
  })

  test('marcador ausente: recusa a missão com mensagem clara e NUNCA chama o runner interno', async () => {
    const marker = join(dir, 'sem-plugin', 'hooks.json')
    const inner: RuntimeCommandRunner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'nao devia rodar',
      stderr: '',
      durationMs: 1,
    })
    const gated = wrapWithHostGitorchPluginGate(inner, marker)

    const result = await gated({ binary: 'agy', args: [], env: {} })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBe(buildHostPluginMissingMessage(marker))
    expect(inner).not.toHaveBeenCalled()
  })

  test('marcador presente: deixa a missão passar normalmente para o runner interno', async () => {
    const pluginDir = join(dir, 'gitorch-plugin', 'gitorch')
    await mkdir(pluginDir, { recursive: true })
    const marker = join(pluginDir, 'hooks.json')
    await writeFile(marker, '{}')

    const inner: RuntimeCommandRunner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'entregue',
      stderr: '',
      durationMs: 1,
    })
    const gated = wrapWithHostGitorchPluginGate(inner, marker)

    const result = await gated({ binary: 'agy', args: ['--print'], env: {} })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('entregue')
    expect(inner).toHaveBeenCalledTimes(1)
  })

  test('GITORCH_AGY_PLUGIN=0 recusa pelo MESMO motivo do container, mesmo com o marcador presente', async () => {
    const pluginDir = join(dir, 'gitorch-plugin', 'gitorch')
    await mkdir(pluginDir, { recursive: true })
    const marker = join(pluginDir, 'hooks.json')
    await writeFile(marker, '{}')
    process.env['GITORCH_AGY_PLUGIN'] = '0'

    const inner: RuntimeCommandRunner = vi.fn()
    const gated = wrapWithHostGitorchPluginGate(inner, marker)

    const result = await gated({ binary: 'agy', args: [], env: {} })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBe(GITORCH_HOST_PLUGIN_DISABLED_MESSAGE)
    expect(inner).not.toHaveBeenCalled()
  })
})
