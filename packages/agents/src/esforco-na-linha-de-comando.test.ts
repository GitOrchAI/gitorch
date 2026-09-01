import { describe, expect, test } from 'vitest'
import { createCliRuntimeAdapter } from './runtime-adapter'
import type { RuntimeCommandRequest } from './runtime-adapter'

/**
 * O ESFORÇO PRECISA CHEGAR NA LINHA DE COMANDO.
 *
 * Até 01/09/2026 `request.runtime.reasoning` só virava a variável de ambiente
 * `GITORCH_RUNTIME_REASONING`, que nenhum dos três CLIs lê. Ou seja: dava para
 * configurar esforço e ele não saía do lugar — o motor rodava no padrão dele e
 * ninguém percebia, porque nada falhava.
 *
 * Como cada CLI expressa o esforço é conhecimento do control-plane, medido lá
 * (services/esforco-por-motor.ts). Aqui o adaptador só precisa saber ONDE
 * encaixar o que lhe derem — a mesma injeção que já vale para `modelArgName`.
 */

function adaptadorQueGravaAChamada(
  opts: Parameters<typeof createCliRuntimeAdapter>[0],
  calls: RuntimeCommandRequest[]
): ReturnType<typeof createCliRuntimeAdapter> {
  return createCliRuntimeAdapter({
    ...opts,
    runner: async (request) => {
      calls.push(request)
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
    },
  })
}

const credencial = {
  connectionId: 'conn-1',
  ownerScope: 'project' as const,
  providedSecrets: [],
}

describe('o esforço vira argumento de verdade', () => {
  test('claude: --effort entra na linha de comando junto do modelo', async () => {
    const calls: RuntimeCommandRequest[] = []
    const adapter = adaptadorQueGravaAChamada(
      {
        runtime: 'claude',
        binary: 'claude',
        args: ['-p', '--permission-mode', 'plan'],
        modelArgName: '--model',
        effortArgs: (esforco) => ['--effort', esforco],
      },
      calls
    )

    await adapter.run({
      missionId: 'm1',
      prompt: 'analise',
      runtime: { runtime: 'claude', model: 'claude-opus-5', reasoning: 'xhigh' },
      credentialRef: { ...credencial, runtime: 'claude' },
    })

    expect(calls[0]?.args).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      '--model',
      'claude-opus-5',
      '--effort',
      'xhigh',
      'analise',
    ])
  })

  test('codex: o esforço é chave de configuração, não flag', async () => {
    const calls: RuntimeCommandRequest[] = []
    const adapter = adaptadorQueGravaAChamada(
      {
        runtime: 'codex',
        binary: 'codex',
        args: ['exec', '-s', 'read-only'],
        modelArgName: '--model',
        effortArgs: (esforco) => ['-c', `model_reasoning_effort=${esforco}`],
      },
      calls
    )

    await adapter.run({
      missionId: 'm2',
      prompt: 'analise',
      runtime: { runtime: 'codex', model: 'GPT-5.5', reasoning: 'high' },
      credentialRef: { ...credencial, runtime: 'codex' },
    })

    expect(calls[0]?.args).toEqual([
      'exec',
      '-s',
      'read-only',
      '--model',
      'GPT-5.5',
      '-c',
      'model_reasoning_effort=high',
      'analise',
    ])
  })

  test('motor sem esforço separável não ganha argumento nenhum', async () => {
    // O antigravity é registrado SEM `effortArgs` de propósito: lá `--effort`
    // junto de `--model` é erro duro do CLI (medido ao vivo em 01/09/2026:
    // "invalid model selection ... --effort is not supported for model ...").
    const calls: RuntimeCommandRequest[] = []
    const adapter = adaptadorQueGravaAChamada(
      {
        runtime: 'antigravity',
        binary: 'agy',
        args: ['--sandbox'],
        modelArgName: '--model',
        promptArgName: '--print',
      },
      calls
    )

    await adapter.run({
      missionId: 'm3',
      prompt: 'analise',
      runtime: {
        runtime: 'antigravity',
        model: 'Gemini 3.7 Flash (High)',
        reasoning: 'high',
      },
      credentialRef: { ...credencial, runtime: 'antigravity' },
    })

    expect(calls[0]?.args).toEqual([
      '--sandbox',
      '--model',
      'Gemini 3.7 Flash (High)',
      '--print',
      'analise',
    ])
    expect(calls[0]?.args).not.toContain('--effort')
  })

  test('sem esforço na missão, a linha de comando fica exatamente como era', async () => {
    const calls: RuntimeCommandRequest[] = []
    const adapter = adaptadorQueGravaAChamada(
      {
        runtime: 'claude',
        binary: 'claude',
        args: ['-p'],
        modelArgName: '--model',
        effortArgs: (esforco) => ['--effort', esforco],
      },
      calls
    )

    await adapter.run({
      missionId: 'm4',
      prompt: 'analise',
      runtime: { runtime: 'claude', model: 'claude-sonnet-5' },
      credentialRef: { ...credencial, runtime: 'claude' },
    })

    expect(calls[0]?.args).toEqual(['-p', '--model', 'claude-sonnet-5', 'analise'])
  })
})
