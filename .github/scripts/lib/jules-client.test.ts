import { describe, it, expect } from 'vitest'
import { extractSessionId, isJulesApology } from './jules-client.js'

describe('extractSessionId', () => {
  it('extrai de link /task/', () => {
    expect(
      extractSessionId('Jules is [on it](https://jules.google.com/task/9081688944479631645).')
    ).toBe('9081688944479631645')
  })
  it('extrai de link /sessions/', () => {
    expect(extractSessionId('ver https://jules.google.com/sessions/abc-123_XY')).toBe('abc-123_XY')
  })
  it('extrai de path sessions/ cru', () => {
    expect(extractSessionId('sessions/deadbeef')).toBe('deadbeef')
  })
  it('retorna null sem link', () => {
    expect(extractSessionId('comentário qualquer sem link')).toBeNull()
  })
})

describe('isJulesApology', () => {
  it('detecta apology em ingles', () => {
    expect(
      isJulesApology(
        "I apologize, but I encountered an unexpected error and wasn't able to complete the task"
      )
    ).toBe(true)
  })
  it('detecta unable to resolve', () => {
    expect(isJulesApology('I was unable to resolve this issue.')).toBe(true)
  })
  it('detecta em pt', () => {
    expect(isJulesApology('Desculpe, não consegui resolver o problema.')).toBe(true)
  })
  it('ignora comentario normal de sucesso', () => {
    expect(isJulesApology('Done! I pushed a commit updating vitest to 4.1.9.')).toBe(false)
  })
})
