import { describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { criarPreparadorDeMontagens } from './scheduler.js'
import { SemCredencialDoMotorError } from '../services/credencial-do-motor.js'

// O caminho do CONTAINER (podman), irmão do que
// scheduler-local-credential-runner.test.ts cobre para o processo local.
//
// Medido no journal de 31/08 (janela de 9h48): 48 ocorrências de "Sem
// credencial conectada de codex ...; missão sem credencial". Em todas elas o
// produto CONSTATAVA que não havia credencial, escrevia isso no log, e subia o
// container mesmo assim — para colher um 401 que ele já sabia que viria,
// pagando ~15s de `podman run` (cronometrado ao vivo) por missão.
const stagingDeTeste = async (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-staging-teste-'))

const registrador = (): {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
} => ({
  warn: vi.fn() as (...args: unknown[]) => void,
  error: vi.fn() as (...args: unknown[]) => void,
})

describe('criarPreparadorDeMontagens — sem credencial, não dispara o container', () => {
  test('materializeToHome false: falha de MOTOR ANTES de qualquer montagem', async () => {
    const materializeToHome = vi.fn().mockResolvedValue(false)
    const preparar = criarPreparadorDeMontagens({
      engineConnections: { materializeToHome },
      stagingBase: await stagingDeTeste(),
      log: registrador(),
    })

    await expect(
      preparar({ env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_1' } })
    ).rejects.toBeInstanceOf(SemCredencialDoMotorError)

    // O motor que importa: só o do próprio runtime foi consultado. O token do
    // GitHub nem chega a ser materializado — não há missão para ele servir.
    expect(materializeToHome).toHaveBeenCalledTimes(1)
    expect(materializeToHome).toHaveBeenCalledWith('user_1', 'codex', expect.any(String))
  })

  test('o staging temporário some mesmo quando a preparação falha', async () => {
    let capturado = ''
    const materializeToHome = vi.fn(async (_u: string, _r: string, dir: string) => {
      capturado = dir
      return false
    })
    const preparar = criarPreparadorDeMontagens({
      engineConnections: { materializeToHome },
      stagingBase: await stagingDeTeste(),
      log: registrador(),
    })

    await expect(
      preparar({ env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_2' } })
    ).rejects.toBeInstanceOf(SemCredencialDoMotorError)

    // Credencial descriptografada nunca fica para trás em host compartilhado.
    await expect(fs.stat(capturado)).rejects.toThrow()
  })

  test('a mensagem diz QUAL motor e QUAL dono — o dono sabe o que religar', async () => {
    const preparar = criarPreparadorDeMontagens({
      engineConnections: { materializeToHome: vi.fn().mockResolvedValue(false) },
      stagingBase: await stagingDeTeste(),
      log: registrador(),
    })

    await expect(
      preparar({ env: { GITORCH_RUNTIME: 'antigravity', GITORCH_OWNER_USER_ID: 'user_7' } })
    ).rejects.toThrow(/antigravity.*user_7/s)
  })

  test('com credencial, monta somente-leitura e segue o caminho de sempre', async () => {
    // O que NÃO pode quebrar: o caminho bom continua idêntico.
    const materializeToHome = vi.fn().mockResolvedValue(true)
    const preparar = criarPreparadorDeMontagens({
      engineConnections: { materializeToHome },
      stagingBase: await stagingDeTeste(),
      log: registrador(),
    })

    const r = await preparar({
      env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_3' },
    })

    expect(r.mounts).toHaveLength(1)
    expect(r.mounts[0]?.target).toBe('/run/gitorch-credentials')
    expect(r.mounts[0]?.readOnly).toBe(true)
    // O token do GitHub entra no MESMO staging — ausência dele é normal.
    expect(materializeToHome).toHaveBeenCalledWith('user_3', 'github', expect.any(String))
    await r.cleanup?.()
  })

  test('missão sem runtime/dono no env não é caso de credencial — segue sem montagem', async () => {
    const preparar = criarPreparadorDeMontagens({
      engineConnections: { materializeToHome: vi.fn().mockResolvedValue(false) },
      stagingBase: await stagingDeTeste(),
      log: registrador(),
    })

    expect((await preparar({ env: {} })).mounts).toEqual([])
  })

  test('falha de DESCRIPTOGRAFIA continua sendo incidente, não vira "sem credencial"', async () => {
    // Os dois casos param a missão, mas por motivos DIFERENTES: um pede login
    // novo do dono, o outro é chave trocada/dado corrompido. Confundir os dois
    // mandaria o dono religar uma conta que não tem problema nenhum.
    const erro = Object.assign(new Error('chave trocada'), { name: 'CredentialDecryptError' })
    const preparar = criarPreparadorDeMontagens({
      engineConnections: { materializeToHome: vi.fn().mockRejectedValue(erro) },
      stagingBase: await stagingDeTeste(),
      log: registrador(),
    })

    await expect(
      preparar({ env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_4' } })
    ).rejects.toMatchObject({ name: 'CredentialDecryptError' })
  })
})
