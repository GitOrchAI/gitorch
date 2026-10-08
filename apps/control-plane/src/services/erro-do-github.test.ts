import { describe, expect, it } from 'vitest'
import { ErroDoGitHub, erroDaRespostaDoGitHub } from './erro-do-github.js'

function resposta(status: number, cabecalhos: Record<string, string> = {}) {
  return { status, headers: new Headers(cabecalhos) }
}

describe('erroDaRespostaDoGitHub', () => {
  it('guarda o status, a mensagem e os três cabeçalhos de limite', () => {
    const erro = erroDaRespostaDoGitHub(
      'GitHub GET /repos/o/r/issues/7 failed (403)',
      resposta(403, {
        'retry-after': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1790000000',
      })
    )
    expect(erro).toBeInstanceOf(ErroDoGitHub)
    expect(erro).toBeInstanceOf(Error)
    expect(erro.message).toBe('GitHub GET /repos/o/r/issues/7 failed (403)')
    expect(erro.status).toBe(403)
    expect(erro.retryAfterSegundos).toBe(60)
    expect(erro.limiteRestante).toBe(0)
    expect(erro.limiteResetaEmSegundos).toBe(1790000000)
  })

  it('cabeçalho ausente ou ilegível vira null, nunca NaN', () => {
    const erro = erroDaRespostaDoGitHub(
      'GitHub GET /x failed (404)',
      resposta(404, { 'retry-after': 'logo', 'x-ratelimit-remaining': '' })
    )
    expect(erro.status).toBe(404)
    expect(erro.retryAfterSegundos).toBeNull()
    expect(erro.limiteRestante).toBeNull()
    expect(erro.limiteResetaEmSegundos).toBeNull()
  })

  it('o nome da classe aparece no log e na mensagem continua o texto antigo', () => {
    const erro = erroDaRespostaDoGitHub('GitHub GET /x failed (500)', resposta(500))
    expect(erro.name).toBe('ErroDoGitHub')
    expect(String(erro)).toContain('failed (500)')
  })
})
