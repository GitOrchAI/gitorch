import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CredentialDecryptError,
  CredentialEncryptError,
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

// Achado Crítico 2 (revisão da Task 5/F8): loadKey() lançava `Error`
// genérico — não `CredentialDecryptError` — quando GITORCH_CREDENTIAL_KEY
// está ausente ou com tamanho errado, e isso rodava ANTES do try/catch de
// decryptCredential (que só embrulhava falha de decipher.final()/tag).
// Numa rotação de chave com propagação incompleta (cenário real: é
// exatamente para isto que FORMAT_VERSION existe), o erro chegava como
// `Error` comum — `instanceof CredentialDecryptError` dava `false` — e o
// chamador (renovarTokensGithubVencendo, github-token-refresh.ts) marcava o
// cliente como "precisa reconectar" por uma falha de infraestrutura NOSSA.
describe('credential-crypto: falha ao CARREGAR a chave também é CredentialDecryptError (achado Crítico 2)', () => {
  const original = process.env['GITORCH_CREDENTIAL_KEY']
  afterEach(() => {
    if (original === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = original
  })

  test('GITORCH_CREDENTIAL_KEY ausente: decryptCredential lança CredentialDecryptError (não Error genérico)', () => {
    delete process.env['GITORCH_CREDENTIAL_KEY']
    // O envelope em si é irrelevante — loadKey() falha ANTES de ler o
    // envelope, então qualquer string chega a exercitar o caminho.
    expect(() => decryptCredential('qualquer-coisa')).toThrow(CredentialDecryptError)
  })

  test('GITORCH_CREDENTIAL_KEY com tamanho errado: decryptCredential lança CredentialDecryptError (não Error genérico)', () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = 'deadbeef'
    expect(() => decryptCredential('qualquer-coisa')).toThrow(CredentialDecryptError)
  })

  test('a mensagem do CredentialDecryptError fala da chave do SERVIDOR, nunca de um valor de credencial', () => {
    delete process.env['GITORCH_CREDENTIAL_KEY']
    let mensagem = ''
    try {
      decryptCredential('qualquer-coisa')
    } catch (err) {
      mensagem = (err as Error).message
    }
    expect(mensagem).toMatch(/GITORCH_CREDENTIAL_KEY/)
    expect(mensagem).not.toContain('qualquer-coisa')
  })
})

// Achado Médio 3 (revisão da Task 5/F8): a correção do achado Crítico 2
// (acima) só reembalou a falha de loadKey() em decryptCredential —
// encryptCredential continuou deixando o Error genérico atravessar cru.
// Mesma causa-raiz, metade corrigida. Estes testes são o par simétrico
// EXATO dos de "credential-crypto: falha ao CARREGAR a chave também é
// CredentialDecryptError" acima, do lado de CIFRAR.
describe('credential-crypto: falha ao CARREGAR a chave também é CredentialEncryptError do lado de CIFRAR (achado Médio 3)', () => {
  const original = process.env['GITORCH_CREDENTIAL_KEY']
  afterEach(() => {
    if (original === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = original
  })

  test('GITORCH_CREDENTIAL_KEY ausente: encryptCredential lança CredentialEncryptError (não Error genérico)', () => {
    delete process.env['GITORCH_CREDENTIAL_KEY']
    let capturado: unknown
    try {
      encryptCredential('qualquer-coisa')
    } catch (err) {
      capturado = err
    }
    // `.name` além de `instanceof`/`toThrow(Classe)`: distingue de verdade
    // um `Error` genérico ('Error') de `CredentialEncryptError`, sem
    // depender só da referência de classe (que um import quebrado
    // resolveria como `undefined` e degradaria `toThrow(undefined)` para
    // "aceita qualquer erro" — o mesmo risco que a suíte de
    // CredentialDecryptError já evita ao lado).
    expect(capturado).toBeInstanceOf(CredentialEncryptError)
    expect((capturado as Error)?.name).toBe('CredentialEncryptError')
  })

  test('GITORCH_CREDENTIAL_KEY com tamanho errado: encryptCredential lança CredentialEncryptError (não Error genérico)', () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = 'deadbeef'
    let capturado: unknown
    try {
      encryptCredential('qualquer-coisa')
    } catch (err) {
      capturado = err
    }
    expect(capturado).toBeInstanceOf(CredentialEncryptError)
    expect((capturado as Error)?.name).toBe('CredentialEncryptError')
  })

  test('a mensagem do CredentialEncryptError fala da chave do SERVIDOR, nunca do texto puro sendo cifrado', () => {
    delete process.env['GITORCH_CREDENTIAL_KEY']
    let mensagem = ''
    try {
      encryptCredential('segredo-em-texto-puro')
    } catch (err) {
      mensagem = (err as Error).message
    }
    expect(mensagem).toMatch(/GITORCH_CREDENTIAL_KEY/)
    expect(mensagem).not.toContain('segredo-em-texto-puro')
  })
})
