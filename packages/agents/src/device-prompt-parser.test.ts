import { describe, it, expect } from 'vitest'
import { parseDevicePrompt, isDeviceRuntime } from './device-prompt-parser.js'

describe('parseDevicePrompt', () => {
  it('parses the real codex device-auth prompt (url + one-time code)', () => {
    const out = [
      'Follow these steps to sign in with ChatGPT using device code authorization:',
      '1. Open this link in your browser and sign in to your account',
      '   https://auth.openai.com/codex/device',
      '2. Enter this one-time code (expires in 15 minutes)',
      '   S9RP-CRRAG',
    ].join('\n')
    expect(parseDevicePrompt(out, 'codex')).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'S9RP-CRRAG',
    })
  })

  it('parses the real claude setup-token OAuth url (no CLI code — user pastes it back)', () => {
    // Stdout do Claude sob PTY, com escapes ANSI intercalados (como no spike).
    const out =
      'Browser didn\x1b[1C\x1b[1Adidn\x27t open? Use the url below to sign in\n' +
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed&response_type=code&scope=user%3Ainference&state=abc'
    const r = parseDevicePrompt(out, 'claude')
    expect(r.url).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed&response_type=code&scope=user%3Ainference&state=abc'
    )
    expect(r.code).toBeUndefined()
  })

  it('parses the real antigravity Google OAuth url (re-tested 2026-07-07 — IS automatable)', () => {
    const out =
      'Welcome to the Antigravity CLI. You are currently not signed in.\n' +
      'Select login method:\n1. Google OAuth\n2. Use a Google Cloud project\n' +
      'Open this URL to authenticate:\n' +
      'https://accounts.google.com/o/oauth2/auth?client_id=abc123&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid+email&state=xyz\n' +
      'Paste the authorization code below: authorization code…'
    const r = parseDevicePrompt(out, 'antigravity')
    expect(r.url).toBe(
      'https://accounts.google.com/o/oauth2/auth?client_id=abc123&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid+email&state=xyz'
    )
    expect(r.code).toBeUndefined()
  })

  it('isDeviceRuntime narrows valid runtime strings', () => {
    expect(isDeviceRuntime('codex')).toBe(true)
    expect(isDeviceRuntime('claude')).toBe(true)
    expect(isDeviceRuntime('antigravity')).toBe(true)
    expect(isDeviceRuntime('github')).toBe(false)
    expect(isDeviceRuntime('bogus')).toBe(false)
  })
})
