import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearManifestCache,
  getEngineVersions,
  getResourcesRef,
  loadManifest,
} from './version-manifest.js'

// Mesmo padrão de environment.test.ts: o namespace ESM nativo de 'node:fs' é
// read-only e não deixa `vi.spyOn(fs, 'readFileSync')` funcionar direto.
// Reexportar o módulo real por trás de um objeto plano o torna espionável,
// sem trocar o comportamento (todas as funções continuam as reais).
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()
  return { ...actual, default: actual }
})

const VALID_MANIFEST = {
  schemaVersion: 1,
  engines: {
    claude: { npm: '@anthropic-ai/claude-code', version: '2.1.200' },
    codex: { npm: '@openai/codex', version: '0.142.5' },
    antigravity: {
      binary: 'agy',
      version: '1.1.4',
      sha256: { arm64: 'abc123', x86_64: 'def456' },
      sizeBytes: 177229744,
    },
  },
  resources: {
    repo: 'https://github.com/loureng/gitorch.git',
    commit: '54fd1b55de762aa366be56ec02334c838185b110',
    packages: {
      cadence: 'packages/cadence',
      cgc: 'packages/cgc',
      memoria: 'packages/cortex + packages/synapse + packages/graph-rag',
    },
  },
}

describe('version-manifest', () => {
  let tmpDir: string
  let manifestPath: string
  const originalEnv = process.env['GITORCH_MANIFEST_PATH']

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitorch-manifest-'))
    manifestPath = path.join(tmpDir, 'manifest.json')
    clearManifestCache()
    delete process.env['GITORCH_MANIFEST_PATH']
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    clearManifestCache()
    vi.restoreAllMocks()
    if (originalEnv === undefined) delete process.env['GITORCH_MANIFEST_PATH']
    else process.env['GITORCH_MANIFEST_PATH'] = originalEnv
  })

  test('lê as versões certas dos 3 motores a partir do path explícito', () => {
    fs.writeFileSync(manifestPath, JSON.stringify(VALID_MANIFEST))
    const manifest = loadManifest(manifestPath)
    const versions = getEngineVersions(manifest)

    expect(versions).toHaveLength(3)
    expect(versions).toContainEqual({
      name: 'claude',
      version: '2.1.200',
      npm: '@anthropic-ai/claude-code',
    })
    expect(versions).toContainEqual({
      name: 'codex',
      version: '0.142.5',
      npm: '@openai/codex',
    })
    expect(versions).toContainEqual({
      name: 'antigravity',
      version: '1.1.4',
      binary: 'agy',
      sha256: { arm64: 'abc123', x86_64: 'def456' },
    })
  })

  test('lê o path a partir de GITORCH_MANIFEST_PATH quando nenhum arg é passado', () => {
    fs.writeFileSync(manifestPath, JSON.stringify(VALID_MANIFEST))
    process.env['GITORCH_MANIFEST_PATH'] = manifestPath
    const manifest = loadManifest()
    expect(getEngineVersions(manifest)).toHaveLength(3)
  })

  test('path ausente (nem arg nem env) → erro claro', () => {
    expect(() => loadManifest()).toThrowError(
      /GITORCH_MANIFEST_PATH não configurado.*manifesto de versões do repo privado/
    )
  })

  test('arquivo inexistente → erro claro com o path', () => {
    const missing = path.join(tmpDir, 'nao-existe.json')
    expect(() => loadManifest(missing)).toThrowError(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  })

  test('JSON inválido → erro claro', () => {
    fs.writeFileSync(manifestPath, '{ isto não é json')
    expect(() => loadManifest(manifestPath)).toThrowError(/JSON válido/)
  })

  test('schemaVersion errado → erro claro', () => {
    fs.writeFileSync(manifestPath, JSON.stringify({ ...VALID_MANIFEST, schemaVersion: 2 }))
    expect(() => loadManifest(manifestPath)).toThrowError(/schemaVersion/)
  })

  test('getResourcesRef devolve repo/commit/packages', () => {
    fs.writeFileSync(manifestPath, JSON.stringify(VALID_MANIFEST))
    const manifest = loadManifest(manifestPath)
    expect(getResourcesRef(manifest)).toEqual(VALID_MANIFEST.resources)
  })

  test('cache: não relê o arquivo do disco na segunda chamada com o mesmo path', () => {
    fs.writeFileSync(manifestPath, JSON.stringify(VALID_MANIFEST))
    const spy = vi.spyOn(fs, 'readFileSync')

    loadManifest(manifestPath)
    expect(spy).toHaveBeenCalledTimes(1)

    loadManifest(manifestPath)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('clearManifestCache força reler do disco', () => {
    fs.writeFileSync(manifestPath, JSON.stringify(VALID_MANIFEST))
    const spy = vi.spyOn(fs, 'readFileSync')

    loadManifest(manifestPath)
    clearManifestCache()
    loadManifest(manifestPath)

    expect(spy).toHaveBeenCalledTimes(2)
  })
})
