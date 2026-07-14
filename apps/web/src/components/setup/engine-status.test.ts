import { describe, it, expect } from 'vitest'
import {
  modelCount,
  parseTokenResponse,
  normalizeLoginState,
  classifyConnectError,
  connectErrorHintKey,
  parseSetupStatus,
  isProvisionTerminal,
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

// A verdade do provisionamento vem de GET /api/v1/setup/status (o estado REAL
// da missão `clone_and_start_engines` no banco). O sinal antigo — a lista de
// motores — era uma TAUTOLOGIA: o submit só passa com um motor conectado e a
// linha 'github' nasce conectada no OAuth, então o primeiro poll SEMPRE achava
// um motor "connected" e pintava ✓ verde enquanto a missão ainda estava pending.
describe('parseSetupStatus', () => {
  it('pendente -> pending (o wizard diz "provisionando", nunca "pronto")', () => {
    expect(parseSetupStatus({ status: 'pending', error: null })).toEqual({
      status: 'pending',
      error: null,
    })
  })

  it('em andamento -> running (o scheduler pegou a missão)', () => {
    expect(parseSetupStatus({ status: 'running', error: null })).toEqual({
      status: 'running',
      error: null,
    })
  })

  it('concluída -> completed (só AQUI o ✓ verde é verdade)', () => {
    expect(parseSetupStatus({ status: 'completed', error: null })).toEqual({
      status: 'completed',
      error: null,
    })
  })

  it('falhou -> failed COM a causa real do backend (o cliente sabe o que aconteceu)', () => {
    expect(
      parseSetupStatus({ status: 'failed', error: 'git clone falhou: repositório não encontrado' })
    ).toEqual({ status: 'failed', error: 'git clone falhou: repositório não encontrado' })
  })

  it('falhou sem causa -> error null (a UI cai num texto localizado, não numa mentira)', () => {
    expect(parseSetupStatus({ status: 'failed', error: null })).toEqual({
      status: 'failed',
      error: null,
    })
    expect(parseSetupStatus({ status: 'failed', error: '   ' })).toEqual({
      status: 'failed',
      error: null,
    })
  })

  it('causa pendurada num estado bom é ruído -> ignorada', () => {
    expect(parseSetupStatus({ status: 'completed', error: 'falha antiga' })).toEqual({
      status: 'completed',
      error: null,
    })
  })

  it('payload nulo/malformado/estado desconhecido -> unknown (segue no polling, nunca chuta ✓)', () => {
    expect(parseSetupStatus(null)).toEqual({ status: 'unknown', error: null })
    expect(parseSetupStatus(undefined)).toEqual({ status: 'unknown', error: null })
    expect(parseSetupStatus({})).toEqual({ status: 'unknown', error: null })
    expect(parseSetupStatus({ status: 'ready' })).toEqual({ status: 'unknown', error: null })
    expect(parseSetupStatus({ status: 42 })).toEqual({ status: 'unknown', error: null })
  })
})

describe('isProvisionTerminal', () => {
  it('completed e failed são terminais (o polling para)', () => {
    expect(isProvisionTerminal('completed')).toBe(true)
    expect(isProvisionTerminal('failed')).toBe(true)
  })

  it('pending, running e unknown NÃO são terminais (o polling continua)', () => {
    expect(isProvisionTerminal('pending')).toBe(false)
    expect(isProvisionTerminal('running')).toBe(false)
    expect(isProvisionTerminal('unknown')).toBe(false)
  })
})
