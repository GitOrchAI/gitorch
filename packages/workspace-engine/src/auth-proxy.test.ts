import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { AuthProxy } from './auth-proxy.js'

describe('AuthProxy', () => {
  it('should detect a password prompt and allow responding via callback', () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()

    const proxy = new AuthProxy({ stdout, stdin })
    const promptHandler = vi.fn()
    proxy.on('prompt', promptHandler)

    // Simulate stdout writing a prompt
    stdout.write('Password: ')

    expect(promptHandler).toHaveBeenCalledTimes(1)
    const [message, respond] = promptHandler.mock.calls[0]
    expect(message).toBe('Password: ')
    expect(typeof respond).toBe('function')

    // Test callback response
    let stdinData = ''
    stdin.on('data', (chunk) => {
      stdinData += chunk.toString()
    })

    respond('my-secret-password')

    expect(stdinData).toBe('my-secret-password\n')
    proxy.destroy()
  })

  it('should allow responding via provideAnswer method', () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()

    const proxy = new AuthProxy({ stdout, stdin })

    let stdinData = ''
    stdin.on('data', (chunk) => {
      stdinData += chunk.toString()
    })

    proxy.provideAnswer('another-answer')

    expect(stdinData).toBe('another-answer\n')
    proxy.destroy()
  })

  it('should detect various authentication keywords case-insensitively', () => {
    const keywords = ['token', 'code', 'password', 'prompt', 'auth', 'login']

    for (const keyword of keywords) {
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const proxy = new AuthProxy({ stdout, stdin })
      const promptHandler = vi.fn()
      proxy.on('prompt', promptHandler)

      stdout.write(`Please enter your ${keyword}: `)

      expect(promptHandler).toHaveBeenCalledTimes(1)
      expect(promptHandler.mock.calls[0][0]).toContain(keyword)
      proxy.destroy()
    }
  })

  it('should ignore regular output without auth patterns', () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const proxy = new AuthProxy({ stdout, stdin })
    const promptHandler = vi.fn()
    proxy.on('prompt', promptHandler)

    stdout.write('Clone completed successfully\n')
    stdout.write('Unrelated output logs...\n')

    expect(promptHandler).not.toHaveBeenCalled()
    proxy.destroy()
  })

  it('should handle fragmented stream outputs using sliding window buffer', () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const proxy = new AuthProxy({ stdout, stdin })
    const promptHandler = vi.fn()
    proxy.on('prompt', promptHandler)

    // Write fragmented prompt
    stdout.write('Pass')
    expect(promptHandler).not.toHaveBeenCalled()

    stdout.write('word: ')
    expect(promptHandler).toHaveBeenCalledTimes(1)
    expect(promptHandler.mock.calls[0][0]).toContain('Password')
    proxy.destroy()
  })

  it('should not leak memory and correctly cleanup listeners on destroy', () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const proxy = new AuthProxy({ stdout, stdin })
    const promptHandler = vi.fn()
    proxy.on('prompt', promptHandler)

    proxy.destroy()

    stdout.write('Password: ')
    expect(promptHandler).not.toHaveBeenCalled()
  })
})
