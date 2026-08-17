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

/** Erro específico de falha ao CIFRAR (achado Médio 3, revisão da Task
 *  5/F8): simétrico a `CredentialDecryptError`, mesma causa-raiz (a chave do
 *  servidor, `GITORCH_CREDENTIAL_KEY`, ausente ou malformada). A correção
 *  anterior (achado Crítico 2) só reembalou essa falha em `decryptCredential`
 *  — `encryptCredential` continuou deixando o `Error` genérico de `loadKey()`
 *  atravessar cru, metade da correção. Existe para quem chama poder
 *  distinguir "a chave do servidor está com problema" (aqui) de qualquer
 *  outra causa, do mesmo jeito que `CredentialDecryptError` já permite do
 *  lado da leitura. */
export class CredentialEncryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialEncryptError'
  }
}

/** Formato aceito por GITORCH_CREDENTIAL_KEY: 32 bytes em hex[64] ou base64.
 *  Exportado para env.ts validar a mesma regra NO BOOT (achado Crítico 2 da
 *  Task 5/F8) — uma chave ausente ou malformada só aparecia tarde, no meio
 *  de uma renovação em produção, em vez de derrubar o processo já na
 *  subida. Única fonte da regra: env.ts não reimplementa o parse, só chama
 *  isto. */
export function formatoDeChaveValido(raw: string): boolean {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return key.length === KEY_BYTES
}

function loadKey(): Buffer {
  const raw = process.env['GITORCH_CREDENTIAL_KEY']
  if (!raw) {
    throw new Error(
      'GITORCH_CREDENTIAL_KEY ausente: necessária para cifrar credenciais de motor (32 bytes em hex ou base64)'
    )
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `GITORCH_CREDENTIAL_KEY inválida: esperados ${KEY_BYTES} bytes, recebidos ${key.length}`
    )
  }
  return key
}

/** Cifra texto puro; retorna um envelope base64 (version|iv|authTag|ciphertext).
 *  Lança `CredentialEncryptError` se a chave do servidor (GITORCH_CREDENTIAL_KEY)
 *  estiver ausente ou com formato inválido (achado Médio 3, Task 5/F8 — a
 *  metade desta correção que faltava; ver o comentário de decryptCredential
 *  abaixo para a metade que já existia). */
export function encryptCredential(plaintext: string): string {
  let key: Buffer
  try {
    key = loadKey()
  } catch (err) {
    // Mesma postura de decryptCredential: a mensagem de loadKey() já fala
    // da CHAVE DO SERVIDOR, nunca do valor em texto puro sendo cifrado (que
    // nem chega a este catch) — só reembalada no tipo certo.
    throw new CredentialEncryptError(
      `Falha ao carregar a chave do servidor para cifrar credencial: ${String(
        (err as { message?: string })?.message ?? err
      )}`
    )
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, authTag, ciphertext]).toString('base64')
}

/** Decifra um envelope produzido por encryptCredential. Lança
 *  CredentialDecryptError se adulterado, chave errada, versão desconhecida
 *  OU a própria chave do servidor (GITORCH_CREDENTIAL_KEY) estiver ausente
 *  ou com formato inválido (achado Crítico 2, Task 5/F8).
 *
 *  ANTES desta correção, `loadKey()` lançava `Error` genérico para os dois
 *  casos acima, e isso acontecia ANTES do try/catch abaixo — ou seja,
 *  passava por cima da distinção inteira que este arquivo existe para
 *  garantir. Numa rotação de chave com propagação incompleta (o cenário
 *  real que FORMAT_VERSION existe para suportar), a leitura chegava ao
 *  chamador (renovarTokensGithubVencendo, github-token-refresh.ts) como
 *  `Error` comum: `instanceof CredentialDecryptError` dava `false`, e o
 *  cliente era marcado como "precisa reconectar" por uma falha de
 *  INFRAESTRUTURA NOSSA — exatamente o que a task inteira existe para
 *  evitar. O try/catch abaixo agora cobre `loadKey()` também, não só o
 *  `decipher.final()`. */
export function decryptCredential(envelope: string): string {
  let key: Buffer
  try {
    key = loadKey()
  } catch (err) {
    // A mensagem de loadKey() já deixa claro que o problema é a CHAVE DO
    // SERVIDOR (nunca o valor da credencial em si — loadKey() não tem
    // acesso ao envelope aqui, só ao GITORCH_CREDENTIAL_KEY) — repassada
    // tal qual, só reembalada no tipo certo.
    throw new CredentialDecryptError(
      `Falha ao carregar a chave do servidor para decifrar credencial: ${String(
        (err as { message?: string })?.message ?? err
      )}`
    )
  }
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
