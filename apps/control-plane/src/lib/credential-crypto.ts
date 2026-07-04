import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Cifragem de credenciais de motor em repouso (AES-256-GCM autenticado).
// A chave vem de GITORCH_CREDENTIAL_KEY (32 bytes em hex[64] ou base64). Sem
// chave válida a operação FALHA — nunca grava/lê credencial de cliente em
// texto puro nem com chave fraca.

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
// Byte de versão de formato no início do envelope: reserva espaço para rotação
// de chave (versões futuras mapeiam versão -> chave). Hoje só a v1 existe.
const FORMAT_VERSION = 1

/** Erro específico de falha ao decifrar (chave trocada/dado adulterado) — para
 *  o chamador distinguir de "não há credencial" e não mascarar o incidente. */
export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialDecryptError'
  }
}

function loadKey(): Buffer {
  const raw = process.env['GITORCH_CREDENTIAL_KEY']
  if (!raw) {
    throw new Error(
      'GITORCH_CREDENTIAL_KEY ausente: necessária para cifrar credenciais de motor (32 bytes em hex ou base64)'
    )
  }
  let key: Buffer
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex')
  } else {
    key = Buffer.from(raw, 'base64')
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `GITORCH_CREDENTIAL_KEY inválida: esperados ${KEY_BYTES} bytes, recebidos ${key.length}`
    )
  }
  return key
}

/** Cifra texto puro; retorna um envelope base64 (version|iv|authTag|ciphertext). */
export function encryptCredential(plaintext: string): string {
  const key = loadKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, authTag, ciphertext]).toString('base64')
}

/** Decifra um envelope produzido por encryptCredential. Lança
 *  CredentialDecryptError se adulterado, chave errada ou versão desconhecida. */
export function decryptCredential(envelope: string): string {
  const key = loadKey()
  const buf = Buffer.from(envelope, 'base64')
  const version = buf[0]
  if (version !== FORMAT_VERSION) {
    throw new CredentialDecryptError(`Versão de envelope de credencial não suportada: ${version}`)
  }
  const iv = buf.subarray(1, 1 + IV_BYTES)
  const authTag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + 16)
  const ciphertext = buf.subarray(1 + IV_BYTES + 16)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new CredentialDecryptError(
      `Falha ao decifrar credencial (chave trocada ou dado corrompido): ${String(
        (err as { message?: string })?.message ?? err
      )}`
    )
  }
}

/** True se há chave válida configurada (para checagens de boot/health). */
export function hasCredentialKey(): boolean {
  try {
    loadKey()
    return true
  } catch {
    return false
  }
}
