import { describe, expect, it } from 'vitest'
import {
  ErroDoGitHub,
  erroDaRespostaDoGitHub,
  lerMotivoDaResposta,
  resumirMotivoDoGitHub,
} from './erro-do-github.js'

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

describe('resumirMotivoDoGitHub', () => {
  it('extrai a mensagem do corpo JSON do GitHub', () => {
    expect(
      resumirMotivoDoGitHub('{"message":"Resource not accessible by integration","status":"403"}')
    ).toBe('Resource not accessible by integration')
  })

  it('corpo que não é JSON vira o texto enxuto, em uma linha', () => {
    expect(resumirMotivoDoGitHub('Bad\n   gateway')).toBe('Bad gateway')
  })

  it('nunca deixa passar credencial nem URL', () => {
    const bruto = JSON.stringify({
      message:
        'falhou com ghs_ABCDEF1234567890 e Bearer abc.def em https://x:segredo@api.github.com/repos/o/r',
    })
    const texto = resumirMotivoDoGitHub(bruto)
    expect(texto).not.toContain('ghs_ABCDEF')
    expect(texto).not.toContain('abc.def')
    expect(texto).not.toContain('segredo')
    expect(texto).not.toContain('https://')
  })

  it.each([
    ['token <valor>', 'falhou com token a1b2c3d4e5f6g7h8 no cabeçalho', 'a1b2c3d4e5f6g7h8'],
    ['Bearer <valor>', 'cabeçalho Authorization: Bearer abcdef0123456789', 'abcdef0123456789'],
    ['PAT clássico', 'usou ghp_0123456789abcdefABCDEF0123456789abcd na chamada', 'ghp_0123'],
    [
      'PAT fino',
      'usou github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz na chamada',
      'github_pat_11',
    ],
    ['token de instalação', 'usou ghs_0123456789abcdefABCDEF0123456789abcd', 'ghs_0123'],
    [
      'JWT',
      'assertion eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJlQUJDREVGR0g falhou',
      'eyJhbGciOi',
    ],
  ])('esconde %s', (_nome, mensagem, pedaco) => {
    const texto = resumirMotivoDoGitHub(JSON.stringify({ message: mensagem }))
    expect(texto).not.toContain(pedaco)
    expect(texto).toContain('[credencial]')
  })

  it('a palavra "token" em frase comum não vira credencial', () => {
    expect(resumirMotivoDoGitHub('{"message":"Bad credentials: token expired"}')).toBe(
      'Bad credentials: token expired'
    )
  })

  it('corta mensagem enorme', () => {
    expect(resumirMotivoDoGitHub('x'.repeat(5000)).length).toBeLessThanOrEqual(200)
  })

  it('vazio ou ilegível devolve texto vazio', () => {
    expect(resumirMotivoDoGitHub('')).toBe('')
    expect(resumirMotivoDoGitHub('{"outra":1}')).toBe('')
  })
})

describe('lerMotivoDaResposta', () => {
  it('lê o corpo da resposta sem consumir o original', async () => {
    const r = new Response('{"message":"Issues are disabled for this repo"}', { status: 410 })
    expect(await lerMotivoDaResposta(r)).toBe('Issues are disabled for this repo')
  })

  it('corpo que não abre devolve vazio, nunca lança', async () => {
    const r = {
      clone: () => ({
        text: async () => {
          throw new Error('x')
        },
      }),
    } as unknown as Response
    expect(await lerMotivoDaResposta(r)).toBe('')
  })
})
