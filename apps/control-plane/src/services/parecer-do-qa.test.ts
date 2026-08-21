import { describe, it, expect } from 'vitest'
import {
  acharParecerNesteHead,
  ehAprovacao,
  MARCA_DO_PARECER,
  MARCA_DE_APROVACAO,
} from './parecer-do-qa.js'

const marcada = (extra = '', commit = 'sha1') => ({
  body: `${MARCA_DO_PARECER}\n${extra}`,
  commit_id: commit,
})

describe('acharParecerNesteHead', () => {
  it('sem review nenhuma → sem parecer', () => {
    expect(acharParecerNesteHead([], 'sha1')).toBeUndefined()
    expect(acharParecerNesteHead(undefined, 'sha1')).toBeUndefined()
  })

  it('review de humano (sem a marca) não conta como parecer nosso', () => {
    expect(acharParecerNesteHead([{ body: 'LGTM', commit_id: 'sha1' }], 'sha1')).toBeUndefined()
  })

  it('parecer nosso em commit ANTIGO não vale para o head de agora', () => {
    expect(acharParecerNesteHead([marcada('', 'sha-velho')], 'sha1')).toBeUndefined()
  })

  it('acha o parecer nosso no head atual', () => {
    expect(acharParecerNesteHead([marcada()], 'sha1')?.commit_id).toBe('sha1')
  })

  it('devolve o parecer MAIS RECENTE do mesmo head, não o primeiro', () => {
    const achado = acharParecerNesteHead(
      [marcada(`verdict: ${MARCA_DE_APROVACAO}`), marcada('verdict: REQUEST_CHANGES')],
      'sha1'
    )
    expect(achado?.body).toContain('REQUEST_CHANGES')
    expect(ehAprovacao(achado)).toBe(false)
  })

  it('reconhece aprovação', () => {
    expect(ehAprovacao(marcada(MARCA_DE_APROVACAO))).toBe(true)
  })
})
