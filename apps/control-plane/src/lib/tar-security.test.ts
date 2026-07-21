import { describe, expect, test } from 'vitest'
import { Unpack } from 'tar'
import path from 'node:path'
import fs from 'node:fs'

describe('tar security check', () => {
  test('deve impedir extração de hardlink fora do diretório de destino', async () => {
    const tempDir = path.resolve('./tmp-test-tar')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    try {
      // Instancia o Unpack do tar
      const unpacker = new Unpack({
        cwd: tempDir,
      })

      let observedWarning: string | null = null
      unpacker.on('warn', (code: string, message: string) => {
        if (code === 'TAR_ENTRY_ERROR') {
          observedWarning = message
        }
      })

      // Simulamos a entrada de um HARDLINK que aponta para fora do diretório de destino (ex: /etc/passwd ou ../passwd)
      const mockEntry = {
        type: 'Link',
        path: 'unsafe-link',
        linkpath: '../outside-file',
        absolute: path.join(tempDir, 'unsafe-link'),
        resume: () => {},
      }

      const hardlinkSymbol = Object.getOwnPropertySymbols(Unpack.prototype).find(
        (s) => s.toString() === 'Symbol(hardlink)'
      )

      if (hardlinkSymbol) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(unpacker as any)[hardlinkSymbol](mockEntry, () => {})
      }

      expect(observedWarning).not.toBeNull()
      expect(observedWarning).toContain('hardlink outside extraction directory')
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }
  })
})
