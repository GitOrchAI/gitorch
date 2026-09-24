import { afterEach, describe, expect, test } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isBinaryOnPath,
  resolveExecutionLimitsMode,
  wrapWithLimits,
  isRecoverableFailure,
} from './execution-limits'

import { isQuotaExhaustedFailure } from './execution-limits'

describe('isQuotaExhaustedFailure', () => {
  test('returns true for stderr containing quota exhaustion keywords', () => {
    expect(isQuotaExhaustedFailure(null, 'Quota excedida')).toBe(true)
    expect(isQuotaExhaustedFailure(null, 'quota exhausted')).toBe(true)
    expect(isQuotaExhaustedFailure(null, 'QUOTA_EXHAUSTED')).toBe(true)
  })

  test('returns false for other stderr messages', () => {
    expect(isQuotaExhaustedFailure(null, 'Some other error')).toBe(false)
    expect(isQuotaExhaustedFailure(null, 'rate limit exceeded')).toBe(false)
  })
})

describe('isRecoverableFailure', () => {
  test('returns true for exit code 124 (timeout)', () => {
    expect(isRecoverableFailure(124)).toBe(true)
  })

  test('returns true for stderr containing timeout keywords', () => {
    expect(isRecoverableFailure(1, 'Error: ETiMeDoUt error')).toBe(true)
    expect(isRecoverableFailure(null, 'process timeout exceeded')).toBe(true)
    expect(isRecoverableFailure(2, 'ECONNRESET occurred')).toBe(true)
  })

  test('returns false for other exit codes and unrelated stderr', () => {
    expect(isRecoverableFailure(1)).toBe(false)
    expect(isRecoverableFailure(0, 'success')).toBe(false)
    expect(isRecoverableFailure(2, 'Unknown error ENOTFOUND')).toBe(false)
  })
})

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
  const limits = { memoryMax: '2G', memorySwapMax: '0', cpuQuota: '150%' }

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

    test('monta o argv certo: --user --scope --quiet -p MemoryMax=<x> -p MemorySwapMax=<z> -p CPUQuota=<y> -- <cmd> <args>', () => {
      dir = mkdtempSync(join(tmpdir(), 'gitorch-systemd-run-'))
      writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'systemd-run'), 0o755)

      const result = wrapWithLimits('claude', ['-p', 'oi'], limits, {
        env: { GITORCH_EXEC_LIMITS: 'systemd', PATH: dir },
      })

      expect(result).toEqual({
        binary: 'systemd-run',
        args: [
          '--user',
          '--scope',
          '--quiet',
          '-p',
          'MemoryMax=2G',
          '-p',
          'MemorySwapMax=0',
          '-p',
          'CPUQuota=150%',
          '--',
          'claude',
          '-p',
          'oi',
        ],
      })
    })

    test('opcional: parâmetros exclusivos de CI/diagnóstico não afetam a execução normal se ausentes', () => {
      dir = mkdtempSync(join(tmpdir(), 'gitorch-systemd-run-'))
      writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'systemd-run'), 0o755)

      const limitsWithDiagnostic = {
        ...limits,
        diagnosticCpuQuota: '200%',
        diagnosticMemoryMax: '4G',
        diagnosticTimeoutMs: 300000,
      }

      const result = wrapWithLimits('claude', ['-p', 'oi'], limitsWithDiagnostic, {
        env: { GITORCH_EXEC_LIMITS: 'systemd', PATH: dir },
      })

      // O comando original wrapWithLimits *não* usa os campos diagnostic diretamente no argv,
      // ele usa memoryMax, memorySwapMax, cpuQuota (os valores de base),
      // as missões de CI que precisarão usar esses campos para sobrepor os normais
      // (a serem lidos antes do wrapWithLimits na missão).
      // Este teste assegura que o tipo interface os aceita e o wrap não quebra.
      expect(result.args).toContain('MemoryMax=2G')
      expect(result.args).not.toContain('MemoryMax=4G')
    })

    // Regressão: esta é a alma da task W5.3 — provado ao vivo que SEM
    // MemorySwapMax, MemoryMax sozinho não mata o processo (ele escorre pra
    // swap). Este teste garante que o argv sempre carrega o -p MemorySwapMax,
    // não importa o valor configurado.
    test('regressão: MemorySwapMax sempre presente no argv (sem ele, o teto não mata — provado ao vivo)', () => {
      dir = mkdtempSync(join(tmpdir(), 'gitorch-systemd-run-'))
      writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'systemd-run'), 0o755)

      const result = wrapWithLimits(
        'claude',
        ['-p', 'oi'],
        { memoryMax: '64M', memorySwapMax: '0', cpuQuota: '150%' },
        { env: { GITORCH_EXEC_LIMITS: 'systemd', PATH: dir } }
      )

      const idx = result.args.indexOf('-p')
      expect(result.args).toContain('MemorySwapMax=0')
      expect(idx).toBeGreaterThanOrEqual(0)
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
