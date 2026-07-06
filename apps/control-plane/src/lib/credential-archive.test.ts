import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  archiveDirectory,
  archivePaths,
  readArchiveEntry,
  restoreDirectory,
} from './credential-archive.js'

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

describe('credential-archive', () => {
  test('empacota e restaura preservando estrutura e conteúdo', async () => {
    const src = await tmp('gitorch-cred-src-')
    await fs.mkdir(path.join(src, 'antigravity-cli', 'bin'), { recursive: true })
    await fs.writeFile(path.join(src, 'auth.json'), '{"token":"secret"}')
    await fs.writeFile(path.join(src, 'antigravity-cli', 'bin', 'agentapi'), 'BIN', { mode: 0o755 })

    const blob = await archiveDirectory(src)
    expect(blob).toBeTruthy()

    const dest = await tmp('gitorch-cred-dest-')
    await restoreDirectory(blob as string, dest)

    expect(await fs.readFile(path.join(dest, 'auth.json'), 'utf8')).toBe('{"token":"secret"}')
    const restoredBin = path.join(dest, 'antigravity-cli', 'bin', 'agentapi')
    expect(await fs.readFile(restoredBin, 'utf8')).toBe('BIN')
    // Segurança: credencial restaurada é 0600 (nunca legível por outros nem
    // executável), independente do modo capturado (apenas em sistemas Unix).
    if (process.platform !== 'win32') {
      expect((await fs.stat(restoredBin)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.join(dest, 'auth.json'))).mode & 0o777).toBe(0o600)
      // Diretório raiz 0700.
      expect((await fs.stat(dest)).mode & 0o777).toBe(0o700)
    }

    await fs.rm(src, { recursive: true, force: true })
    await fs.rm(dest, { recursive: true, force: true })
  })

  test('retorna null quando o diretório não existe', async () => {
    expect(await archiveDirectory('/tmp/gitorch-nao-existe-xyz')).toBeNull()
  })

  test('recusa entrada com path traversal em blob adulterado', async () => {
    const dest = await tmp('gitorch-cred-evil-')
    const evil = JSON.stringify({
      version: 1,
      entries: [
        { path: '../escapou.txt', mode: 0o600, content: Buffer.from('x').toString('base64') },
      ],
    })
    await expect(restoreDirectory(evil, dest)).rejects.toThrow('fora da raiz')
    await fs.rm(dest, { recursive: true, force: true })
  })

  test('readArchiveEntry lê uma entrada do blob direto em memória, sem tocar o disco', async () => {
    const src = await tmp('gitorch-cred-readentry-')
    await fs.mkdir(path.join(src, '.gitorch'), { recursive: true })
    await fs.writeFile(path.join(src, '.gitorch', 'gh-token'), 'github_pat_ABC123\n')

    const blob = await archivePaths(src, ['.gitorch/gh-token'])
    expect(blob).toBeTruthy()
    expect(readArchiveEntry(blob as string, '.gitorch/gh-token')).toBe('github_pat_ABC123\n')
    expect(readArchiveEntry(blob as string, 'nao-existe')).toBeNull()

    await fs.rm(src, { recursive: true, force: true })
  })
})
