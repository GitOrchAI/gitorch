import { describe, it, expect } from 'vitest'
import { classificarOrigem, origemPrecisaDeReclassificacao } from './origem-do-item.js'

describe('classificarOrigem', () => {
  it('dependabot[bot] como autor → dependabot', () => {
    expect(
      classificarOrigem({
        autor: 'dependabot[bot]',
        labels: [],
        corpo: null,
        commits: [],
        temSessaoGitOrch: false,
      })
    ).toBe('dependabot')
  })

  it('rodapé do dev + sessão do GitOrch → jules_gitorch', () => {
    expect(
      classificarOrigem({
        autor: 'gitorch-bot',
        labels: [],
        corpo:
          'PR created automatically by Jules for task [42](https://jules.google.com/task/42) started by @loureng',
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
        corpo:
          'PR created automatically by Jules for task [1](https://jules.google.com/task/1) started by @outra-pessoa',
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
        commits: [
          {
            mensagem: 'fix: x\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
            autorLogin: 'loureng',
          },
        ],
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
      classificarOrigem({
        autor: 'renovate[bot]',
        labels: [],
        corpo: null,
        commits: [],
        temSessaoGitOrch: false,
      })
    ).toBe('outro_bot')
  })
})

describe('origemPrecisaDeReclassificacao', () => {
  it('issue #877 (PR #583): jules_fora sem issueNumber é baixa confiança → precisa reclassificar', () => {
    expect(origemPrecisaDeReclassificacao({ origem: 'jules_fora', issueNumber: null })).toBe(true)
  })

  it('jules_gitorch já com issueNumber → já classificado com confiança, não reprocessa', () => {
    expect(origemPrecisaDeReclassificacao({ origem: 'jules_gitorch', issueNumber: 580 })).toBe(
      false
    )
  })

  it('jules_fora com issueNumber já preenchido → não reprocessa (não deveria acontecer, mas o sinal é explícito)', () => {
    expect(origemPrecisaDeReclassificacao({ origem: 'jules_fora', issueNumber: 580 })).toBe(false)
  })

  it('pessoa, dependabot, assistente, outro_bot → nunca precisam de reclassificação', () => {
    for (const origem of ['pessoa', 'dependabot', 'assistente', 'outro_bot']) {
      expect(origemPrecisaDeReclassificacao({ origem, issueNumber: null })).toBe(false)
    }
  })

  it('ficha ainda sem origem nenhuma (null) → não é o sinal de jules_fora, não reprocessa aqui', () => {
    expect(origemPrecisaDeReclassificacao({ origem: null, issueNumber: null })).toBe(false)
  })
})
