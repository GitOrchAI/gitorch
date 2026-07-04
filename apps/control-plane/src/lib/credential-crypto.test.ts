import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CredentialDecryptError,
  decryptCredential,
  encryptCredential,
  hasCredentialKey,
} from './credential-crypto.js'

describe('credential-crypto', () => {
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']

  beforeEach(() => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  test('cifra e decifra de volta ao original', () => {
    const secret = JSON.stringify({ token: 'abc', refresh: 'xyz' })
    const envelope = encryptCredential(secret)
    expect(envelope).not.toContain('abc')
    expect(decryptCredential(envelope)).toBe(secret)
  })

  test('cada cifragem usa IV novo (envelopes diferentes para o mesmo texto)', () => {
    const a = encryptCredential('mesmo')
    const b = encryptCredential('mesmo')
    expect(a).not.toBe(b)
    expect(decryptCredential(a)).toBe('mesmo')
    expect(decryptCredential(b)).toBe('mesmo')
  })

  test('envelope adulterado falha na autenticação (GCM)', () => {
    const envelope = encryptCredential('dado')
    const buf = Buffer.from(envelope, 'base64')
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01
    expect(() => decryptCredential(buf.toString('base64'))).toThrow()
  })

  test('aceita chave em base64', () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('base64')
    expect(decryptCredential(encryptCredential('ok'))).toBe('ok')
  })

  test('rejeita ausência de chave e chave de tamanho errado', () => {
    delete process.env['GITORCH_CREDENTIAL_KEY']
    expect(hasCredentialKey()).toBe(false)
    expect(() => encryptCredential('x')).toThrow('GITORCH_CREDENTIAL_KEY ausente')
    process.env['GITORCH_CREDENTIAL_KEY'] = 'deadbeef'
    expect(() => encryptCredential('x')).toThrow('inválida')
  })
})

describe('credential-crypto v2 (versão + erro tipado)', () => {
  const original = process.env['GITORCH_CREDENTIAL_KEY']
  beforeEach(() => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
  })
  afterEach(() => {
    if (original === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = original
  })

  test('envelope começa com o byte de versão 1', () => {
    const env = encryptCredential('x')
    expect(Buffer.from(env, 'base64')[0]).toBe(1)
  })

  test('descriptografar com chave errada lança CredentialDecryptError', () => {
    const env = encryptCredential('segredo')
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    expect(() => decryptCredential(env)).toThrow(CredentialDecryptError)
  })
})
