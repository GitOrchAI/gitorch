import { describe, expect, it } from 'vitest'
import {
  CredencialExpiradaError,
  deveAvisarDeNovo,
  ehCredencialExpirada,
} from './credencial-do-motor.js'

describe('ehCredencialExpirada', () => {
  it('reconhece o recado do motor mesmo com código de saída 0', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: '',
        stderr:
          'ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.',
      })
    ).toBe(true)
  })

  it('reconhece pela recusa de autorização', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: '',
        stderr: 'failed to connect to websocket: HTTP error: 401 Unauthorized',
      })
    ).toBe(true)
  })

  it('não confunde com falta de cota', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 1,
        stdout: '',
        stderr: 'rate limit exceeded, try again later',
      })
    ).toBe(false)
  })

  it('não confunde com erro comum', () => {
    expect(ehCredencialExpirada({ exitCode: 1, stdout: '', stderr: 'file not found' })).toBe(false)
  })

  it('olha também a saída normal, não só a de erro', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: 'Please log out and sign in again',
        stderr: '',
      })
    ).toBe(true)
  })

  it('reconhece invalid_grant (recusa clássica de OAuth)', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: '',
        stderr: 'Error: invalid_grant — token expired',
      })
    ).toBe(true)
  })

  it('reconhece "authentication required" sem depender de maiúsculas', () => {
    expect(
      ehCredencialExpirada({
        exitCode: 0,
        stdout: 'AUTHENTICATION REQUIRED — please sign in.',
        stderr: '',
      })
    ).toBe(true)
  })
})

describe('CredencialExpiradaError', () => {
  it('carrega o motor para quem captura, sem depender de casar texto de novo', () => {
    const err = new CredencialExpiradaError('motor codex pediu novo login', 'codex')
    expect(err).toBeInstanceOf(Error)
    expect(err.runtime).toBe('codex')
    expect(err.name).toBe('CredencialExpiradaError')
  })
})

describe('deveAvisarDeNovo — dedup em memória, uma vez por motor por dia', () => {
  const UM_DIA_MS = 24 * 60 * 60 * 1000

  it('primeiro aviso (chave nunca vista): deve avisar', () => {
    const registro = new Map<string, number>()
    expect(deveAvisarDeNovo(registro, 'user-1:codex', 1000)).toBe(true)
  })

  it('mesmo dia, mesma chave: NÃO deve avisar de novo (SPAM apaga sinal tanto quanto silêncio)', () => {
    const registro = new Map<string, number>([['user-1:codex', 1000]])
    expect(deveAvisarDeNovo(registro, 'user-1:codex', 1000 + 60_000)).toBe(false)
  })

  it('passado um dia inteiro: deve avisar de novo (ainda quebrado, lembrete diário)', () => {
    const registro = new Map<string, number>([['user-1:codex', 1000]])
    expect(deveAvisarDeNovo(registro, 'user-1:codex', 1000 + UM_DIA_MS)).toBe(true)
  })

  it('chave diferente (outro motor/dono): não é afetada pelo aviso anterior', () => {
    const registro = new Map<string, number>([['user-1:codex', 1000]])
    expect(deveAvisarDeNovo(registro, 'user-1:antigravity', 1000 + 60_000)).toBe(true)
  })
})
