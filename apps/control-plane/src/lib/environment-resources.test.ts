import { describe, expect, it } from 'vitest'
import { summarizeResourcesLock } from './environment-resources.js'

// Formato REAL gravado pelo bootstrap-env.sh privado (mesmo LOCK_CONTENT que
// services/environment.test.ts usa para o bootstrap em si) — este arquivo
// testa só a TRADUÇÃO desse lock cru para o que o wizard pode mostrar ao
// dono, sem paths internos nem sha completo.
const RAW_LOCK = {
  generatedAt: '2026-07-20T00:00:00Z',
  engines: {
    claude: { npm: '@anthropic-ai/claude-code', version: '2.1.200', cache: '/x' },
    codex: { npm: '@openai/codex', version: '0.142.5', cache: '/x' },
    antigravity: { binary: 'agy', version: '1.1.4', sha256: 'abc', arch: 'arm64', cache: '/x' },
  },
  resources: { repo: 'https://github.com/loureng/gitorch.git', commit: 'abc123def456' },
}

describe('summarizeResourcesLock', () => {
  it('lock bem-formado -> name+version dos 3 motores (ordem claude/codex/antigravity) + commit curto', () => {
    expect(summarizeResourcesLock(RAW_LOCK)).toEqual({
      engines: [
        { name: 'claude', version: '2.1.200' },
        { name: 'codex', version: '0.142.5' },
        { name: 'antigravity', version: '1.1.4' },
      ],
      commit: 'abc123d',
    })
  })

  it('NUNCA expõe npm/cache/sha256/binary/arch/repo — só name+version+commit', () => {
    const result = summarizeResourcesLock(RAW_LOCK)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('npm')
    expect(serialized).not.toContain('cache')
    expect(serialized).not.toContain('sha256')
    expect(serialized).not.toContain('binary')
    expect(serialized).not.toContain('arch')
    expect(serialized).not.toContain('repo')
    expect(serialized).not.toContain('/x')
  })

  it('commit curto: menor que o corte fica do jeito que está (nunca inventa caractere)', () => {
    const lock = { ...RAW_LOCK, resources: { ...RAW_LOCK.resources, commit: 'ab1' } }
    expect(summarizeResourcesLock(lock)?.commit).toBe('ab1')
  })

  it('resourcesLock null (bootstrap ainda não rodou) -> null', () => {
    expect(summarizeResourcesLock(null)).toBeNull()
  })

  it('resourcesLock undefined -> null', () => {
    expect(summarizeResourcesLock(undefined)).toBeNull()
  })

  it('resourcesLock que não é objeto (string/array) -> null', () => {
    expect(summarizeResourcesLock('oops')).toBeNull()
    expect(summarizeResourcesLock(['a', 'b'])).toBeNull()
    expect(summarizeResourcesLock(42)).toBeNull()
  })

  it('sem a chave engines -> null (lock malformado, nunca mostra bloco pela metade)', () => {
    expect(summarizeResourcesLock({ resources: { commit: 'abc1234' } })).toBeNull()
  })

  it('engines vazio (nenhum motor reconhecido) -> null', () => {
    expect(summarizeResourcesLock({ engines: {}, resources: { commit: 'abc1234' } })).toBeNull()
  })

  it('motor desconhecido (fora de claude/codex/antigravity) é ignorado, não quebra os demais', () => {
    const lock = {
      engines: {
        claude: { version: '2.1.200' },
        exotic: { version: '9.9.9' },
      },
      resources: { commit: 'abc1234' },
    }
    expect(summarizeResourcesLock(lock)).toEqual({
      engines: [{ name: 'claude', version: '2.1.200' }],
      commit: 'abc1234',
    })
  })

  it('motor sem version (string) é ignorado', () => {
    const lock = {
      engines: {
        claude: { npm: '@anthropic-ai/claude-code' },
        codex: { version: '0.142.5' },
      },
      resources: { commit: 'abc1234' },
    }
    expect(summarizeResourcesLock(lock)).toEqual({
      engines: [{ name: 'codex', version: '0.142.5' }],
      commit: 'abc1234',
    })
  })

  it('sem resources.commit -> null (nunca mostra motores sem a versão dos recursos)', () => {
    expect(
      summarizeResourcesLock({
        engines: { claude: { version: '2.1.200' } },
      })
    ).toBeNull()
  })

  it('resources.commit vazio/whitespace -> null', () => {
    expect(
      summarizeResourcesLock({
        engines: { claude: { version: '2.1.200' } },
        resources: { commit: '   ' },
      })
    ).toBeNull()
  })
})
