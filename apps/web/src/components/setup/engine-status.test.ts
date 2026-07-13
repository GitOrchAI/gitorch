import { describe, it, expect } from 'vitest'
import {
  modelCount,
  parseTokenResponse,
  normalizeLoginState,
  classifyConnectError,
  connectErrorHintKey,
  deriveProvisionStatus,
} from './engine-status'

describe('modelCount', () => {
  it('conta o tamanho de uma lista de modelos (o que a liveness/SSE entrega)', () => {
    expect(modelCount(['gpt-5', 'gpt-5-mini', 'o4'])).toBe(3)
  })

  it('lista vazia é 0 (motor conectou mas não expôs catálogo ainda)', () => {
    expect(modelCount([])).toBe(0)
  })

  it('passa um número adiante (já normalizado pelo refetch)', () => {
    expect(modelCount(7)).toBe(7)
  })

  it('undefined/null/string/NaN -> undefined (não renderiza a linha)', () => {
    expect(modelCount(undefined)).toBeUndefined()
    expect(modelCount(null)).toBeUndefined()
    expect(modelCount('gpt-5')).toBeUndefined()
    expect(modelCount(Number.NaN)).toBeUndefined()
  })
})

describe('parseTokenResponse', () => {
  const fallback = 'Não deu para conectar.'

  it('connected:true + status connected -> connected com contagem de modelos e quota', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: ['a', 'b'], quotaRemaining: 42 } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: 2, quota: 42 })
  })

  it('quota ausente vira null (provider sem quota) sem quebrar', () => {
    const state = parseTokenResponse(
      { connected: true, status: { status: 'connected', models: [] } },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: 0, quota: null })
  })

  it('anti-fachada: liveness reprovou (status error) -> error com a causa real, nunca connected', () => {
    const state = parseTokenResponse(
      {
        connected: false,
        status: { status: 'error', lastError: 'motor não respondeu à validação' },
      },
      fallback
    )
    expect(state).toEqual({ phase: 'error', message: 'motor não respondeu à validação' })
  })

  it('erro 400 da rota (error de topo) -> error com essa mensagem', () => {
    const state = parseTokenResponse({ error: 'token de claude inválido: vazio' }, fallback)
    expect(state).toEqual({ phase: 'error', message: 'token de claude inválido: vazio' })
  })

  it('sem causa nenhuma -> cai no fallback localizado', () => {
    expect(parseTokenResponse(null, fallback)).toEqual({ phase: 'error', message: fallback })
    expect(parseTokenResponse({ connected: false, status: { status: 'error' } }, fallback)).toEqual(
      {
        phase: 'error',
        message: fallback,
      }
    )
  })
})

describe('normalizeLoginState', () => {
  const fallback = 'Não deu para conectar.'

  it('AO VIVO: connected traz models como LISTA -> vira contagem (casa com o refetch)', () => {
    const state = normalizeLoginState(
      { phase: 'connected', models: ['gpt-5', 'o4', 'haiku'], quota: 88 },
      fallback
    )
    expect(state).toEqual({ phase: 'connected', models: 3, quota: 88 })
  })

  it('connected sem quota -> quota null, sem quebrar a linha de prova de vida', () => {
    expect(normalizeLoginState({ phase: 'connected', models: [] }, fallback)).toEqual({
      phase: 'connected',
      models: 0,
      quota: null,
    })
  })

  it('preserva url_ready (url + code) sem tocar', () => {
    expect(
      normalizeLoginState({ phase: 'url_ready', url: 'https://x/y', code: 'AB-CD' }, fallback)
    ).toEqual({ phase: 'url_ready', url: 'https://x/y', code: 'AB-CD' })
  })

  it('url_ready sem url é payload quebrado -> erro honesto', () => {
    expect(normalizeLoginState({ phase: 'url_ready' }, fallback)).toEqual({
      phase: 'error',
      message: fallback,
    })
  })

  it('preserva error com a mensagem do backend; sem mensagem cai no fallback', () => {
    expect(normalizeLoginState({ phase: 'error', message: 'tempo esgotado' }, fallback)).toEqual({
      phase: 'error',
      message: 'tempo esgotado',
    })
    expect(normalizeLoginState({ phase: 'error' }, fallback)).toEqual({
      phase: 'error',
      message: fallback,
    })
  })

  it('starting passa direto; fase desconhecida/malformada -> erro honesto', () => {
    expect(normalizeLoginState({ phase: 'starting' }, fallback)).toEqual({ phase: 'starting' })
    expect(normalizeLoginState({ phase: 'wat' }, fallback)).toEqual({
      phase: 'error',
      message: fallback,
    })
    expect(normalizeLoginState(null, fallback)).toEqual({ phase: 'error', message: fallback })
  })
})

describe('classifyConnectError', () => {
  it('Termos do Antigravity -> terms', () => {
    expect(classifyConnectError('Você precisa aceitar os Termos para continuar')).toBe('terms')
  })

  it('falha de captura / liveness reprovada -> capture', () => {
    expect(classifyConnectError('login encerrado sem token (código de saída 1)')).toBe('capture')
    expect(classifyConnectError('motor não respondeu à validação viva')).toBe('capture')
    expect(classifyConnectError('tempo esgotado (captura travada); tente novamente')).toBe(
      'capture'
    )
  })

  it('erro genérico de rede -> generic', () => {
    expect(classifyConnectError('Não deu para conectar. Confira e tente de novo.')).toBe('generic')
    expect(classifyConnectError(undefined)).toBe('generic')
    expect(classifyConnectError('')).toBe('generic')
  })
})

describe('connectErrorHintKey', () => {
  it('mapeia cada tipo para a chave de dica que aponta o paste manual', () => {
    expect(connectErrorHintKey('terms')).toBe('setup.connectErrorHintTerms')
    expect(connectErrorHintKey('capture')).toBe('setup.connectErrorHintCapture')
    expect(connectErrorHintKey('generic')).toBe('setup.connectErrorHintGeneric')
  })
})

describe('deriveProvisionStatus', () => {
  it('nada ainda (null/lista vazia) -> provisioning (segue no polling, não trava)', () => {
    expect(deriveProvisionStatus(null)).toBe('provisioning')
    expect(deriveProvisionStatus(undefined)).toBe('provisioning')
    expect(deriveProvisionStatus([])).toBe('provisioning')
  })

  it('pelo menos um motor conectado -> ready (fim do spinner eterno)', () => {
    expect(deriveProvisionStatus([{ runtime: 'claude', status: 'connected', models: ['a'] }])).toBe(
      'ready'
    )
    // conectado vence um erro de outro motor (basta um vivo pra seguir)
    expect(
      deriveProvisionStatus([
        { runtime: 'codex', status: 'error' },
        { runtime: 'claude', status: 'connected' },
      ])
    ).toBe('ready')
  })

  it('nenhum conectado mas algum em erro -> failed (mostra retry, não spinner)', () => {
    expect(deriveProvisionStatus([{ runtime: 'codex', status: 'error' }])).toBe('failed')
  })

  it('só estados não-terminais (ex.: revoked/pending) -> provisioning', () => {
    expect(deriveProvisionStatus([{ runtime: 'codex', status: 'revoked' }])).toBe('provisioning')
  })
})
