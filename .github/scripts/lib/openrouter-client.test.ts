import { describe, it, expect } from 'vitest'
import {
  isModerationModel,
  isBadOutput,
  sanitizeResponse,
  validateFreeRoute,
} from './openrouter-client.js'

describe('rota free enforcement', () => {
  it('aceita a rota free', () => {
    expect(() => validateFreeRoute('openrouter/free')).not.toThrow()
  })
  it('aceita sufixo :free', () => {
    expect(() => validateFreeRoute('qwen/qwen3-coder:free')).not.toThrow()
  })
  it('rejeita modelo pago', () => {
    expect(() => validateFreeRoute('openai/gpt-4o')).toThrow()
  })
  it('rejeita string vazia', () => {
    expect(() => validateFreeRoute('')).toThrow()
  })
})

describe('deteccao de modelo de moderacao (campo model da resposta)', () => {
  it('detecta content-safety', () => {
    expect(isModerationModel('nvidia/nemotron-3.5-content-safety:free')).toBe(true)
  })
  it('detecta guard', () => {
    expect(isModerationModel('meta-llama/llama-guard-3:free')).toBe(true)
  })
  it('detecta moderation', () => {
    expect(isModerationModel('some/text-moderation:free')).toBe(true)
  })
  it('aceita modelo normal de codigo', () => {
    expect(isModerationModel('qwen/qwen3-coder:free')).toBe(false)
  })
  it('aceita llama instruct', () => {
    expect(isModerationModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(false)
  })
})

describe('deteccao de saida ruim', () => {
  it('rejeita veredito de moderacao explicito', () => {
    expect(isBadOutput('User Safety: safe')).toBe(true)
  })
  it('rejeita variacao de safety', () => {
    expect(isBadOutput('Safety: safe')).toBe(true)
  })
  it('rejeita apenas a palavra safe', () => {
    expect(isBadOutput('safe')).toBe(true)
  })
  it('rejeita vazio', () => {
    expect(isBadOutput('   ')).toBe(true)
  })
  it('rejeita curto demais', () => {
    expect(isBadOutput('ok')).toBe(true)
  })
  it('aceita resposta real', () => {
    expect(isBadOutput('Atualize o pacote vitest para 4.1.9 conforme o advisory GHSA-xxxx.')).toBe(
      false
    )
  })
})

describe('sanitizeResponse', () => {
  it('NAO apaga a palavra SAFE de texto legitimo', () => {
    expect(sanitizeResponse('This is a SAFE upgrade with no breaking changes')).toContain(
      'SAFE upgrade'
    )
  })
  it('remove linha de veredito ancorada', () => {
    const out = sanitizeResponse('User Safety: safe\nAtualize o pacote para a versao corrigida.')
    expect(out).not.toMatch(/User Safety: safe/)
    expect(out).toContain('Atualize o pacote')
  })
  it('preserva conteudo normal', () => {
    expect(sanitizeResponse('Corrija a dependencia X.')).toBe('Corrija a dependencia X.')
  })
})
