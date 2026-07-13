import { describe, expect, test, vi } from 'vitest'
import { validatePastedCredential, type CredentialKind } from './credential-validator.js'

// Um auth.json do Codex com a forma real (modo chatgpt): tokens.access_token.
const CODEX_CHATGPT = JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { access_token: 'aaa.bbb.ccc', refresh_token: 'r', account_id: 'x' },
})
// Modo apikey: OPENAI_API_KEY preenchido, sem tokens.
const CODEX_APIKEY = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-abc' })

describe('validatePastedCredential', () => {
  describe('codex (auth.json colado)', () => {
    test('aceita auth.json real (modo chatgpt: tokens.access_token)', () => {
      expect(validatePastedCredential('codex', 'file', CODEX_CHATGPT)).toBeNull()
    })
    test('aceita auth.json real (modo apikey: OPENAI_API_KEY)', () => {
      expect(validatePastedCredential('codex', 'file', CODEX_APIKEY)).toBeNull()
    })

    // O CORAÇÃO do achado: o `codex login status` responde exit 0 "Logged in"
    // para qualquer JSON parseável — estes NÃO podem ser aceitos aqui.
    test.each([
      ['objeto falso grosseiro', '{"fake":"qualquer coisa"}'],
      ['objeto vazio', '{}'],
      ['tokens vazio (sem access_token)', '{"tokens":{}}'],
      ['access_token vazio', '{"tokens":{"access_token":""}}'],
      ['OPENAI_API_KEY vazio', '{"OPENAI_API_KEY":""}'],
      ['array em vez de objeto', '[]'],
      ['string JSON', '"só uma string"'],
      ['número JSON', '42'],
    ])('rejeita %s', (_label, content) => {
      expect(validatePastedCredential('codex', 'file', content)).not.toBeNull()
    })

    test('rejeita conteúdo que não é JSON, e a mensagem cita JSON', () => {
      const err = validatePastedCredential('codex', 'file', 'isto não é json')
      expect(err).toContain('JSON')
    })
  })

  describe('claude (token do setup-token colado — caminho raw)', () => {
    test('aceita token com o prefixo do setup-token', () => {
      expect(validatePastedCredential('claude', 'raw', 'sk-ant-oat01-abcdef123456')).toBeNull()
    })
    test('aceita o fake canônico dos testes (sk-ant-oat01-FAKE)', () => {
      expect(validatePastedCredential('claude', 'raw', 'sk-ant-oat01-FAKE')).toBeNull()
    })
    test.each([
      ['lixo sem prefixo', 'lixo-fake-token'],
      ['prefixo errado', 'sk-ant-api03-xxxxxxxx'],
      ['só o prefixo, sem corpo', 'sk-ant-oat'],
      ['vazio', ''],
    ])('rejeita %s', (_label, content) => {
      expect(validatePastedCredential('claude', 'raw', content)).not.toBeNull()
    })

    test('prefixo é sobrescrevível por GITORCH_CLAUDE_TOKEN_PREFIX', async () => {
      const original = process.env['GITORCH_CLAUDE_TOKEN_PREFIX']
      process.env['GITORCH_CLAUDE_TOKEN_PREFIX'] = 'oat_custom_'
      try {
        // O módulo lê o env no topo (no import); resetModules força o reeval.
        vi.resetModules()
        const mod = await import('./credential-validator.js')
        expect(mod.validatePastedCredential('claude', 'raw', 'oat_custom_abcdef')).toBeNull()
        expect(mod.validatePastedCredential('claude', 'raw', 'sk-ant-oat01-abcdef')).not.toBeNull()
      } finally {
        if (original === undefined) delete process.env['GITORCH_CLAUDE_TOKEN_PREFIX']
        else process.env['GITORCH_CLAUDE_TOKEN_PREFIX'] = original
        vi.resetModules()
      }
    })

    test.each([
      ['string vazia', ''],
      ['só espaços', '   '],
    ])(
      'prefixo %s conta como NÃO-setado (usa o default, não desliga a checagem)',
      async (_l, val) => {
        const original = process.env['GITORCH_CLAUDE_TOKEN_PREFIX']
        process.env['GITORCH_CLAUDE_TOKEN_PREFIX'] = val
        try {
          vi.resetModules()
          const mod = await import('./credential-validator.js')
          // se o vazio "desligasse" a checagem, startsWith('') aceitaria "lixo"
          expect(mod.validatePastedCredential('claude', 'raw', 'lixo')).not.toBeNull()
          expect(mod.validatePastedCredential('claude', 'raw', 'sk-ant-oat01-abcdef')).toBeNull()
        } finally {
          if (original === undefined) delete process.env['GITORCH_CLAUDE_TOKEN_PREFIX']
          else process.env['GITORCH_CLAUDE_TOKEN_PREFIX'] = original
          vi.resetModules()
        }
      }
    )
  })

  describe('claude (.credentials.json colado — caminho de arquivo, defesa em profundidade)', () => {
    test('aceita .credentials.json com claudeAiOauth.accessToken', () => {
      const real = JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(108) } })
      expect(validatePastedCredential('claude', 'file', real)).toBeNull()
    })
    test.each([
      ['objeto falso', '{"fake":"x"}'],
      ['sem accessToken', '{"claudeAiOauth":{}}'],
      ['não é JSON', 'lixo'],
    ])('rejeita %s', (_label, content) => {
      expect(validatePastedCredential('claude', 'file', content)).not.toBeNull()
    })
  })

  describe('antigravity: sem checagem de forma (a liveness `agy models` é o round-trip real)', () => {
    test.each<[string, CredentialKind, string]>([
      ['token qualquer (file)', 'file', 'oauth-token-fake'],
      ['até string curta', 'file', 'x'],
    ])('não bloqueia %s', (_label, kind, content) => {
      expect(validatePastedCredential('antigravity', kind, content)).toBeNull()
    })
  })

  describe('runtime sem regra específica: não bloqueia por forma', () => {
    test('runtime desconhecido passa (o guard de não-suportado é a montante)', () => {
      expect(validatePastedCredential('futuro-motor', 'file', 'qualquer coisa')).toBeNull()
    })
  })
})
