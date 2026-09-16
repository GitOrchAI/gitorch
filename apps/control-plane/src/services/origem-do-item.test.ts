import { describe, it, expect } from 'vitest'
import { classificarOrigem } from './origem-do-item.js'

describe('classificarOrigem', () => {
  it('dependabot[bot] como autor → dependabot', () => {
    expect(
      classificarOrigem({ autor: 'dependabot[bot]', labels: [], corpo: null, commits: [], temSessaoGitOrch: false })
    ).toBe('dependabot')
  })

  it('rodapé do dev + sessão do GitOrch → jules_gitorch', () => {
    expect(
      classificarOrigem({
        autor: 'gitorch-bot',
        labels: [],
        corpo: 'PR created automatically by Jules for task [42](https://jules.google.com/task/42) started by @loureng',
        commits: [],
        temSessaoGitOrch: true,
      })
    ).toBe('jules_gitorch')
  })

  it('rodapé do dev SEM sessão do GitOrch → jules_fora (alguém usou o Jules direto, sem passar pelo produto)', () => {
    expect(
      classificarOrigem({
        autor: 'algum-login',
        labels: [],
        corpo: 'PR created automatically by Jules for task [1](https://jules.google.com/task/1) started by @outra-pessoa',
        commits: [],
        temSessaoGitOrch: false,
      })
    ).toBe('jules_fora')
  })

  it('commit com trailer Co-Authored-By de assistente conhecido → assistente', () => {
    expect(
      classificarOrigem({
        autor: 'loureng',
        labels: [],
        corpo: null,
        commits: [{ mensagem: 'fix: x\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>', autorLogin: 'loureng' }],
        temSessaoGitOrch: false,
      })
    ).toBe('assistente')
  })

  it('sem nenhum sinal de automação → pessoa', () => {
    expect(
      classificarOrigem({
        autor: 'loureng',
        labels: [],
        corpo: 'ajuste manual',
        commits: [{ mensagem: 'fix: x', autorLogin: 'loureng' }],
        temSessaoGitOrch: false,
      })
    ).toBe('pessoa')
  })

  it('bot desconhecido (nem dependabot, nem rodapé do dev) → outro_bot', () => {
    expect(
      classificarOrigem({ autor: 'renovate[bot]', labels: [], corpo: null, commits: [], temSessaoGitOrch: false })
    ).toBe('outro_bot')
  })
})
