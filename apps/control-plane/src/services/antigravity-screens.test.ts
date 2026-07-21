import { describe, it, expect, vi } from 'vitest'
import {
  AntigravityOnboardingScanner,
  MAX_ONBOARDING_AUTO_CONFIRMS,
  KEY_DOWN,
  KEY_RIGHT,
  KEY_ENTER,
} from './antigravity-screens.js'

function fakeWriter() {
  return { writeStdin: vi.fn() }
}

// Estas telas espelham EXATAMENTE os fixtures/textos usados em
// assisted-login.test.ts (describe E3) — a extração não pode mudar o
// comportamento, só o lugar do código.
const TERMS_OF_SERVICE_SCREEN =
  '\n Terms of Service & Data Use\n' +
  ' [x] I agree to the Terms of Service and Privacy Policy\n' +
  ' [Previous]  [Done]\n'
const TRUST_FOLDER_SCREEN =
  '\n Do you trust the contents of this project?\n' +
  ' > Yes, I trust this folder\n' +
  '   No, exit\n'
const COLOR_SCHEME_SCREEN = 'Choose your color scheme\n [Next]\n'

describe('AntigravityOnboardingScanner', () => {
  it('color-scheme: confirma com um único Enter', () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    const result = scanner.scan(COLOR_SCHEME_SCREEN, writer)
    expect(result.loopExceeded).toBe(false)
    expect(writer.writeStdin).toHaveBeenCalledTimes(1)
    expect(writer.writeStdin).toHaveBeenLastCalledWith(KEY_ENTER)
  })

  it('ToS: navega Down→Right→Enter (nunca só Enter, que desmarcaria a checkbox)', async () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    scanner.scan(TERMS_OF_SERVICE_SCREEN, writer)
    await vi.waitFor(() => {
      expect(writer.writeStdin).toHaveBeenCalledTimes(3)
    })
    expect(writer.writeStdin.mock.calls).toEqual([[KEY_DOWN], [KEY_RIGHT], [KEY_ENTER]])
  })

  it('trust-folder (sem colchetes): detectada pelo texto, confirmada com Enter', () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    expect(TRUST_FOLDER_SCREEN).not.toMatch(/\[(?:next|done|get started|continue|finish)\]/i)
    const result = scanner.scan(TRUST_FOLDER_SCREEN, writer)
    expect(result.loopExceeded).toBe(false)
    expect(writer.writeStdin).toHaveBeenCalledTimes(1)
    expect(writer.writeStdin).toHaveBeenLastCalledWith(KEY_ENTER)
  })

  it('sequência real inteira (color-scheme → ToS → trust-folder) confirma cada tela 1x', async () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    let buffer = ''

    buffer += COLOR_SCHEME_SCREEN
    scanner.scan(buffer, writer)
    expect(writer.writeStdin).toHaveBeenCalledTimes(1)

    buffer += TERMS_OF_SERVICE_SCREEN
    scanner.scan(buffer, writer)
    await vi.waitFor(() => {
      expect(writer.writeStdin).toHaveBeenCalledTimes(4)
    })

    buffer += TRUST_FOLDER_SCREEN
    scanner.scan(buffer, writer)
    expect(writer.writeStdin).toHaveBeenCalledTimes(5)

    expect(writer.writeStdin.mock.calls).toEqual([
      [KEY_ENTER], // color-scheme
      [KEY_DOWN],
      [KEY_RIGHT],
      [KEY_ENTER], // ToS
      [KEY_ENTER], // trust-folder
    ])
  })

  it('repaint idêntico de tela conhecida NÃO reconfirma', () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    let buffer = COLOR_SCHEME_SCREEN
    scanner.scan(buffer, writer)
    expect(writer.writeStdin).toHaveBeenCalledTimes(1)

    // Repaint: MESMO conteúdo, buffer não cresceu (nada de novo pra escanear)
    scanner.scan(buffer, writer)
    expect(writer.writeStdin).toHaveBeenCalledTimes(1)
  })

  it('fallback genérico: tela desconhecida com colchetes é confirmada com Enter', () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    const result = scanner.scan('Choose your keybindings:\n [Next]\n', writer)
    expect(result.loopExceeded).toBe(false)
    expect(writer.writeStdin).toHaveBeenCalledTimes(1)
    expect(writer.writeStdin).toHaveBeenLastCalledWith(KEY_ENTER)
  })

  it('loop preso (mesma tela desconhecida repetida além do teto) → loopExceeded', () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    let buffer = ''
    let exceeded = false
    for (let i = 1; i <= 9; i++) {
      buffer += `Tela desconhecida número ${i}:\n [Next]\n`
      const result = scanner.scan(buffer, writer)
      if (result.loopExceeded) exceeded = true
    }
    expect(exceeded).toBe(true)
    expect(writer.writeStdin).toHaveBeenCalledTimes(MAX_ONBOARDING_AUTO_CONFIRMS)
  })

  it('buffer sem nada de novo (região vazia) não faz nada', () => {
    const writer = fakeWriter()
    const scanner = new AntigravityOnboardingScanner()
    const result = scanner.scan('', writer)
    expect(result.loopExceeded).toBe(false)
    expect(writer.writeStdin).not.toHaveBeenCalled()
  })
})
