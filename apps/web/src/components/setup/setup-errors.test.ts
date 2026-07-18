import { describe, expect, it } from 'vitest'
import {
  parseSetupErrorCode,
  parseDiagnosisErrorCode,
  setupErrorHintKey,
  type SetupErrorCode,
} from './setup-errors'

describe('parseSetupErrorCode', () => {
  it('extrai um code conhecido do corpo {error, code} de uma rota do wizard', () => {
    expect(parseSetupErrorCode({ error: 'not found', code: 'REPO_NOT_FOUND' })).toBe(
      'REPO_NOT_FOUND'
    )
  })

  it('code desconhecido (rota antiga/futura) -> null, não quebra o front', () => {
    expect(parseSetupErrorCode({ error: 'x', code: 'SOMETHING_NEW' })).toBeNull()
  })

  it('sem code (resposta antiga) -> null', () => {
    expect(parseSetupErrorCode({ error: 'x' })).toBeNull()
  })

  it('body malformado (null/undefined/array) não lança', () => {
    expect(parseSetupErrorCode(null)).toBeNull()
    expect(parseSetupErrorCode(undefined)).toBeNull()
    expect(parseSetupErrorCode([])).toBeNull()
  })
})

describe('parseDiagnosisErrorCode', () => {
  it('extrai o code do prefixo "CODE: mensagem" (formato de DiagnosisJob.error)', () => {
    expect(parseDiagnosisErrorCode('REPO_ACCESS_DENIED: Authentication failed')).toBe(
      'REPO_ACCESS_DENIED'
    )
  })

  it('prefixo desconhecido -> null (o chamador cai no texto cru atual)', () => {
    expect(parseDiagnosisErrorCode('WHATEVER_NEW: algo')).toBeNull()
  })

  it('mensagem antiga sem prefixo -> null (compatibilidade com jobs anteriores a este PR)', () => {
    expect(parseDiagnosisErrorCode('Something went wrong while cloning')).toBeNull()
  })

  it('null/undefined/vazio -> null', () => {
    expect(parseDiagnosisErrorCode(null)).toBeNull()
    expect(parseDiagnosisErrorCode(undefined)).toBeNull()
    expect(parseDiagnosisErrorCode('')).toBeNull()
  })
})

describe('setupErrorHintKey', () => {
  it('todo SetupErrorCode tem uma chave i18n própria (nunca undefined)', () => {
    const codes: SetupErrorCode[] = [
      'REPO_ACCESS_DENIED',
      'REPO_NOT_FOUND',
      'RATE_LIMITED',
      'DISK_FULL',
      'CLONE_TIMEOUT',
      'DIAG_TIMEOUT',
      'DIAG_EMPTY_REPO',
      'INTERNAL',
    ]
    for (const code of codes) {
      const key = setupErrorHintKey(code)
      expect(typeof key).toBe('string')
      expect(key.length).toBeGreaterThan(0)
      expect(key.startsWith('setup.err')).toBe(true)
    }
    // chaves distintas por code (nenhum colapso acidental)
    expect(new Set(codes.map(setupErrorHintKey)).size).toBe(codes.length)
  })
})
