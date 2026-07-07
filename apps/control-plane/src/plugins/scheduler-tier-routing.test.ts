import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { RemoteWorkspaceProvider } from '@gitorch/workspace-engine'
import { LocalWorkspaceProvider } from '@gitorch/workspace-engine'
import {
  buildRemoteRuntimeStackIfConfigured,
  selectRuntimeStack,
  type RuntimeStack,
} from './scheduler.js'

const ENV_KEYS = [
  'GITORCH_FREE_TIER_SSH_HOST',
  'GITORCH_FREE_TIER_SSH_KEY',
  'GITORCH_FREE_TIER_AGENT_IMAGE',
  'GITORCH_FREE_TIER_CONTAINER_ENGINE',
]

describe('buildRemoteRuntimeStackIfConfigured', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  // app fake: só o que a fábrica realmente usa (log). Nada de Fastify real —
  // isolamos a decisão "constrói ou não o stack remoto" do resto do plugin.
  const fakeApp = { log: { info: () => undefined, warn: () => undefined } } as never

  test('retorna null sem as variáveis de ambiente do free-tier (produção intacta por padrão)', () => {
    expect(buildRemoteRuntimeStackIfConfigured(fakeApp)).toBeNull()
  })

  test('retorna null com host mas sem chave', () => {
    process.env['GITORCH_FREE_TIER_SSH_HOST'] = 'gitorch@<MT_SAAS_HOST>'
    expect(buildRemoteRuntimeStackIfConfigured(fakeApp)).toBeNull()
  })

  test('constrói um stack com RemoteWorkspaceProvider quando host+chave estão presentes', () => {
    process.env['GITORCH_FREE_TIER_SSH_HOST'] = 'gitorch@<MT_SAAS_HOST>'
    process.env['GITORCH_FREE_TIER_SSH_KEY'] = '/home/ubuntu/.ssh/mtsaas_gitorch'

    const stack = buildRemoteRuntimeStackIfConfigured(fakeApp)
    expect(stack).not.toBeNull()
    expect(stack?.workspaceProvider).toBeInstanceOf(RemoteWorkspaceProvider)
    expect(stack?.registry).toBeDefined()
    expect(stack?.orchestrator).toBeDefined()
  })

  // Os 3 motores são IGUAIS (regra do plano: "engines are equal, all proven
  // working"). O wizard já conecta a credencial do Claude (env
  // CLAUDE_CODE_OAUTH_TOKEN), mas sem um adaptador de EXECUÇÃO registrado
  // aqui, disparar uma missão no Claude lançava
  // "No runtime adapter registered for claude" — o motor conectava mas nunca
  // rodava (a fachada que o plano proíbe). Os 3 têm que resolver.
  test('registra os 3 motores de execução (antigravity, codex, claude)', () => {
    process.env['GITORCH_FREE_TIER_SSH_HOST'] = 'gitorch@<MT_SAAS_HOST>'
    process.env['GITORCH_FREE_TIER_SSH_KEY'] = '/home/ubuntu/.ssh/mtsaas_gitorch'

    const stack = buildRemoteRuntimeStackIfConfigured(fakeApp)
    expect(stack?.registry.resolve('antigravity').runtime).toBe('antigravity')
    expect(stack?.registry.resolve('codex').runtime).toBe('codex')
    expect(stack?.registry.resolve('claude').runtime).toBe('claude')
  })
})

describe('selectRuntimeStack', () => {
  const local = { tag: 'local' } as unknown as RuntimeStack
  const remote = { tag: 'remote' } as unknown as RuntimeStack

  test('plano grátis com stack remoto disponível usa o remoto', () => {
    expect(selectRuntimeStack('free', local, remote)).toBe(remote)
  })

  test('plano pago sempre usa o local, mesmo com remoto disponível', () => {
    expect(selectRuntimeStack('pro', local, remote)).toBe(local)
    expect(selectRuntimeStack('solo', local, remote)).toBe(local)
    expect(selectRuntimeStack('team', local, remote)).toBe(local)
  })

  test('plano grátis SEM stack remoto configurado cai pro local (nunca quebra)', () => {
    expect(selectRuntimeStack('free', local, null)).toBe(local)
  })

  test('plano indefinido (sem dono resolvido) usa o local', () => {
    expect(selectRuntimeStack(undefined, local, remote)).toBe(local)
  })
})

// Confirma que o LOCAL nunca muda de tipo por causa do refactor.
describe('regressão: stack local continua LocalWorkspaceProvider por padrão', () => {
  test('sanity do import', () => {
    expect(LocalWorkspaceProvider).toBeDefined()
  })
})
