import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMissionRunner } from './scheduler.js'

// Achado importante da revisão pós-merge: buildMissionRunner só devolvia o
// runner com a trava do plugin de segurança do GitOrch quando
// GITORCH_EXECUTOR=podman. O DEFAULT é 'local-process' — o que a CI usa — e
// nesse caminho a flag --dangerously-skip-permissions (fixa no código)
// rodava sem NENHUMA verificação equivalente. Este teste prova que o caminho
// LOCAL (default, sem GITORCH_EXECUTOR) agora também recusa sem o marcador
// do plugin no host, e deixa passar quando ele existe.

const fakeApp = {
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  engineConnections: {
    // Sem GITORCH_RUNTIME/GITORCH_OWNER_USER_ID no request, o
    // createLocalCredentialRunner nem chega a chamar isto — mas o double
    // precisa existir pro shape bater.
    materializeToHome: async () => false,
  },
} as never
const fakeEnvironments = { current: async () => null } as never

describe('buildMissionRunner (local-process, o default e o que a CI usa) tem a MESMA trava do plugin que o caminho podman', () => {
  let dir: string
  const originalExecutor = process.env['GITORCH_EXECUTOR']
  const originalMarker = process.env['GITORCH_LOCAL_PLUGIN_MARKER']

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gitorch-local-plugin-gate-'))
    delete process.env['GITORCH_EXECUTOR'] // default = local-process
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (originalExecutor === undefined) delete process.env['GITORCH_EXECUTOR']
    else process.env['GITORCH_EXECUTOR'] = originalExecutor
    if (originalMarker === undefined) delete process.env['GITORCH_LOCAL_PLUGIN_MARKER']
    else process.env['GITORCH_LOCAL_PLUGIN_MARKER'] = originalMarker
  })

  test('sem o marcador do plugin no host: a missão é recusada, nunca roda solta', async () => {
    process.env['GITORCH_LOCAL_PLUGIN_MARKER'] = join(dir, 'nao-instalado', 'hooks.json')

    const runner = buildMissionRunner(fakeApp, fakeEnvironments)
    const result = await runner({ binary: 'true', args: [], env: {} })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('missão recusada')
    expect(result.stderr).toContain('gate de segurança do GitOrch')
  })

  test('com o marcador do plugin presente no host: a missão passa e chega a executar', async () => {
    const pluginDir = join(dir, 'gitorch-plugin', 'gitorch')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'hooks.json'), '{}')
    process.env['GITORCH_LOCAL_PLUGIN_MARKER'] = join(pluginDir, 'hooks.json')

    const runner = buildMissionRunner(fakeApp, fakeEnvironments)
    // Sem GITORCH_RUNTIME/GITORCH_OWNER_USER_ID: createLocalCredentialRunner
    // repassa direto pro runner real — 'true' sempre sai com exit 0, prova
    // que o gate deixou passar sem mockar a execução real do agente.
    const result = await runner({ binary: 'true', args: [], env: {} })

    expect(result.exitCode).toBe(0)
  })
})
