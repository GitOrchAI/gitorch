import { describe, it, expect } from 'vitest'
import {
  parseDevicePrompt,
  isDeviceRuntime,
  stripAnsi,
  extractClaudeToken,
} from './device-prompt-parser.js'

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

  it('REGRESSÃO: url do antigravity como hyperlink OSC-8 (alvo+texto colados) não vira URL dupla', () => {
    // Saída REAL do agy capturada no QA manual de 2026-07-12: o CLI imprime a
    // URL como hyperlink OSC-8 — o alvo do link e o texto visível são a MESMA
    // URL, e no buffer (pós-limpeza de CSI) elas ficam coladas SEM espaço:
    // `...state=vneHe4m0oofnRq2s84ptNAhttps://accounts.google.com/...`.
    // O \S+ guloso engolia as duas → Google 404. O match tem que parar na
    // fronteira do segundo https:// e no `]` do terminador `]8;;`.
    const target =
      'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591&code_challenge=HAH9pOMGoeWhsGK&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=vneHe4m0oofnRq2s84ptNA'
    const out =
      'Your browser should open automatically. If not:\n' +
      ` ]8;id=auth-url;${target}\\${target}]8;;\\\n` +
      'If you aren’t automatically redirected, paste the authorization code below:'
    const r = parseDevicePrompt(out, 'antigravity')
    expect(r.url).toBe(target)
    // a URL extraída tem que ser abrível: um único https://, sem lixo de OSC-8
    expect(r.url?.match(/https:\/\//g)?.length).toBe(1)
    expect(r.url).not.toContain(']8;')
  })

  it('isDeviceRuntime narrows valid runtime strings', () => {
    expect(isDeviceRuntime('codex')).toBe(true)
    expect(isDeviceRuntime('claude')).toBe(true)
    expect(isDeviceRuntime('antigravity')).toBe(true)
    expect(isDeviceRuntime('github')).toBe(false)
    expect(isDeviceRuntime('bogus')).toBe(false)
  })
})

describe('stripAnsi', () => {
  it('limpa as formas privadas de CSI (< > = e final != m) que a limpeza antiga deixava como lixo', () => {
    // A limpeza antiga (/\[[0-9;?]*[A-Za-z]/) só aceitava [0-9;?] nos parâmetros
    // e não consumia o ESC: estas quatro (observadas/derivadas da captura A2)
    // sobravam como lixo visível (>4m, >0q, <u, =1;1u).
    const clean = stripAnsi('a\x1b[>4mb\x1b[>0qc\x1b[<ud\x1b[=1;1ue')
    expect(clean).toBe('abcde')
    for (const junk of ['>4m', '>0q', '<u', '=1;1u']) expect(clean).not.toContain(junk)
    expect(clean).not.toContain('\x1b')
  })

  it('consome o byte ESC (0x1b) e as demais famílias de escape do PTY, não só CSI', () => {
    expect(stripAnsi('x\x1b[37my')).toBe('xy') // SGR (CSI)
    expect(stripAnsi('x\x1b7y\x1b8z')).toBe('xyz') // salvar/restaurar cursor (ESC7/ESC8)
    expect(stripAnsi('x\x1b(By')).toBe('xy') // designação de charset G0 (ESC(B)
    expect(stripAnsi('x\x1b]0;título do terminal\x07y')).toBe('xy') // OSC de título (BEL)
    expect(stripAnsi('xy\x1b')).toBe('xy') // ESC solto no fim do buffer
  })

  it('não toca em texto sem escapes (idempotente sobre a URL já limpa)', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=x&state=y'
    expect(stripAnsi(url)).toBe(url)
  })
})

describe('extractClaudeToken', () => {
  it('token cercado E picotado por escapes ANSI/CSI (incl. formas privadas) volta COMPLETO', () => {
    // O modo de falha real: um escape adjacente/no meio do token cortava o match
    // cru no primeiro '['. Aqui o token vem cercado por SGR e formas privadas e
    // partido ao meio por ESC[<u/ESC[=1;1u — stripAnsi junta e o token sai inteiro.
    const body = 'aB3xZ9q7'.repeat(14).slice(0, 108) // 108 chars [A-Za-z0-9]
    const token = `sk-ant-oat01-${body}`
    const cut = 40 // bem depois do prefixo de 13 chars, no miolo do corpo
    const buffer =
      '\x1b[37m\x1b[>4mSuccess! Your token:\r\n' +
      token.slice(0, cut) +
      '\x1b[<u\x1b[=1;1u' + // picote no MEIO com formas privadas
      token.slice(cut) +
      '\x1b[>0q\x1b[39m\r\n\x1b[2GPaste code here >'
    expect(extractClaudeToken(buffer)).toBe(token)
  })

  it('sem token no buffer → null (nunca inventa credencial a partir de ruído do terminal)', () => {
    expect(extractClaudeToken('\x1b[37mnada aqui, só moldura de terminal\x1b[39m')).toBeNull()
    expect(extractClaudeToken('')).toBeNull()
  })

  it('fragmento curto demais (chunk cortou o token cedo) → null, nunca um token parcial', () => {
    // Piso de shape: um prefixo com corpo minúsculo é fragmento/lixo, não token.
    // Quando o resto chega (corpo plausível), extrai completo.
    expect(extractClaudeToken('sk-ant-oat01-abc')).toBeNull()
    expect(extractClaudeToken('sk-ant-oat01-abcdefghij0123')).toBe('sk-ant-oat01-abcdefghij0123')
  })
})

/**
 * O token do Claude tem ~100 chars. A captura dele nunca tinha sido exercida
 * contra saída real: a fixture não contém token nenhum e o único teste com
 * token+ANSI usava uma string inventada à mão. Estes testes fixam o contrato
 * que interessa: extrair o token íntegro, ou NADA — jamais uma credencial
 * corrompida (que passaria na extração e morreria depois como "token inválido",
 * sem ninguém entender por quê).
 */
describe('extractClaudeToken — íntegro ou nada', () => {
  const CORPO = 'AbC123_xyz-DEF456ghi789JKLmno012PQRstu345VWXyz678abc901DEF234ghi567jkl890MNO'
  const TOKEN = `sk-ant-oat01-${CORPO}`

  it('extrai o token quando vem inteiro', () => {
    expect(extractClaudeToken(`Token:\n${TOKEN}\n`)).toBe(TOKEN)
  })

  it('extrai com ANSI colado nas duas pontas', () => {
    expect(extractClaudeToken(`\x1b[37m${TOKEN}\x1b[39m`)).toBe(TOKEN)
  })

  it('NÃO engole a linha seguinte (não devolve credencial corrompida)', () => {
    expect(extractClaudeToken(`${TOKEN}\nFim`)).toBe(TOKEN)
    expect(extractClaudeToken(`${TOKEN}\n\nPronto!`)).toBe(TOKEN)
    expect(extractClaudeToken(`${TOKEN} guarde isso`)).toBe(TOKEN)
  })

  it('devolve null quando não há token (não inventa credencial)', () => {
    expect(extractClaudeToken('Abra a URL e autorize')).toBeNull()
    expect(extractClaudeToken('sk-ant-oat01-cur')).toBeNull()
  })
})
