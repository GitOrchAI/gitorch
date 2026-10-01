import { describe, expect, it } from 'vitest'
import { classificarOrigemEIssueDoPr } from './github-webhook.js'

/**
 * O caso REAL da issue #877: PR #583, branch
 * `fix-tests-and-pipeline-check-16385381233224183643`, sessão
 * `sessions/16385381233224183643` da issue 580 — a ficha dizia
 * `jules_fora`/`issue_number` vazio quando devia dizer `jules_gitorch`/580.
 */
const SESSAO_580 = {
  sessionName: 'sessions/16385381233224183643',
  issueNumber: 580,
  pullRequestNumber: null,
}

describe('classificarOrigemEIssueDoPr', () => {
  it('issue #877 (PR #583): branch com sufixo de sessão do GitOrch vira jules_gitorch com a issue de origem', () => {
    const resultado = classificarOrigemEIssueDoPr({
      payload: {
        pull_request: {
          body: 'PR created automatically by Jules for task [16385381233224183643](https://jules.google.com/task/16385381233224183643) started by @loureng',
          user: { login: 'google-labs-jules[bot]' },
          labels: [],
          head: { ref: 'fix-tests-and-pipeline-check-16385381233224183643' },
        },
      },
      commits: [],
      sessoesDoProjeto: [SESSAO_580],
    })

    expect(resultado).toEqual({ origem: 'jules_gitorch', issueNumber: 580 })
  })

  it('rodapé do dev sem sessão do GitOrch casando vira jules_fora, sem issue', () => {
    const resultado = classificarOrigemEIssueDoPr({
      payload: {
        pull_request: {
          body: 'PR created automatically by Jules for task [999999999999999999](https://jules.google.com/task/999999999999999999) started by @alguem',
          user: { login: 'alguem' },
          labels: [],
          head: { ref: 'fix-algo-999999999999999999' },
        },
      },
      commits: [],
      sessoesDoProjeto: [SESSAO_580],
    })

    expect(resultado).toEqual({ origem: 'jules_fora', issueNumber: null })
  })

  it('dependabot: sinal mais forte, ignora o resto', () => {
    const resultado = classificarOrigemEIssueDoPr({
      payload: {
        pull_request: {
          body: null as unknown as string,
          user: { login: 'dependabot[bot]' },
          labels: [],
        },
      },
      commits: [],
      sessoesDoProjeto: [],
    })
    expect(resultado).toEqual({ origem: 'dependabot', issueNumber: null })
  })

  it('sem nenhum sinal de automação: pessoa, sem issue', () => {
    const resultado = classificarOrigemEIssueDoPr({
      payload: {
        pull_request: {
          body: 'Corrige um typo no README.',
          user: { login: 'loureng' },
          labels: [],
        },
      },
      commits: [{ mensagem: 'fix typo', autorLogin: 'loureng' }],
      sessoesDoProjeto: [],
    })
    expect(resultado).toEqual({ origem: 'pessoa', issueNumber: null })
  })
})
