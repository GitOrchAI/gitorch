import { afterEach, describe, expect, test } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBinaryOnPath, resolveExecutionLimitsMode, wrapWithLimits } from './execution-limits'

describe('resolveExecutionLimitsMode', () => {
  test('sem a variável, cai em none (preserva o comportamento anterior a esta mudança)', () => {
    expect(resolveExecutionLimitsMode({})).toBe('none')
  })

  test('qualquer valor que não seja exatamente "systemd" também cai em none', () => {
    expect(resolveExecutionLimitsMode({ GITORCH_EXEC_LIMITS: 'cgroup-v2' })).toBe('none')
    expect(resolveExecutionLimitsMode({ GITORCH_EXEC_LIMITS: 'Systemd' })).toBe('none')
  })

  test('GITORCH_EXEC_LIMITS=systemd ativa o modo', () => {
    expect(resolveExecutionLimitsMode({ GITORCH_EXEC_LIMITS: 'systemd' })).toBe('systemd')
  })
})

describe('isBinaryOnPath', () => {
  test('PATH ausente ou vazio nunca encontra nada', () => {
    expect(isBinaryOnPath('systemd-run', {})).toBe(false)
    expect(isBinaryOnPath('systemd-run', { PATH: '' })).toBe(false)
  })

  test('PATH apontando para diretório inexistente não lança, só devolve false', () => {
    expect(isBinaryOnPath('systemd-run', { PATH: '/caminho/que/definitivamente/nao/existe' })).toBe(
      false
    )
  })
})

describe('wrapWithLimits', () => {
  const limits = { memoryMax: '2G', cpuQuota: '150%' }

  test('modo none (default) devolve o comando cru, intacto', () => {
    const result = wrapWithLimits('claude', ['-p', 'oi'], limits, { env: {} })
    expect(result).toEqual({ binary: 'claude', args: ['-p', 'oi'] })
  })

  test('modo systemd sem systemd-run no PATH degrada pro comando cru (nunca falha a missão por infra ausente)', () => {
    const result = wrapWithLimits('claude', ['-p', 'oi'], limits, {
      env: { GITORCH_EXEC_LIMITS: 'systemd', PATH: '/caminho/que/nao/existe' },
    })
    expect(result).toEqual({ binary: 'claude', args: ['-p', 'oi'] })
  })

  describe('com um systemd-run de verdade (fake executável) no PATH', () => {
    let dir: string

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    test('monta o argv certo: --scope --quiet -p MemoryMax=<x> -p CPUQuota=<y> -- <cmd> <args>', () => {
      dir = mkdtempSync(join(tmpdir(), 'gitorch-systemd-run-'))
      writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'systemd-run'), 0o755)

      const result = wrapWithLimits('claude', ['-p', 'oi'], limits, {
        env: { GITORCH_EXEC_LIMITS: 'systemd', PATH: dir },
      })

      expect(result).toEqual({
        binary: 'systemd-run',
        args: [
          '--scope',
          '--quiet',
          '-p',
          'MemoryMax=2G',
          '-p',
          'CPUQuota=150%',
          '--',
          'claude',
          '-p',
          'oi',
        ],
      })
    })

    test('preserva args vazios do comando original (sem prompt posicional, ex.: promptViaStdin)', () => {
      dir = mkdtempSync(join(tmpdir(), 'gitorch-systemd-run-'))
      writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'systemd-run'), 0o755)

      const result = wrapWithLimits('agy', [], limits, {
        env: { GITORCH_EXEC_LIMITS: 'systemd', PATH: dir },
      })

      expect(result.binary).toBe('systemd-run')
      expect(result.args.slice(-1)).toEqual(['agy'])
    })
  })
})
