import { describe, it, expect } from 'vitest'
import { missionRoleForEvent } from './github-webhook.js'

describe('missionRoleForEvent', () => {
  it('issue de wishlist recém-aberta -> RA', () => {
    expect(
      missionRoleForEvent('issues', {
        action: 'opened',
        issue: { labels: [{ name: 'bug' }, { name: 'Wishlist' }] },
      })
    ).toBe('ra')
  })

  it('issue aberta SEM label wishlist -> nada', () => {
    expect(
      missionRoleForEvent('issues', { action: 'opened', issue: { labels: [{ name: 'bug' }] } })
    ).toBeNull()
  })

  it('issue de wishlist mas ação não é opened -> nada', () => {
    expect(
      missionRoleForEvent('issues', {
        action: 'labeled',
        issue: { labels: [{ name: 'wishlist' }] },
      })
    ).toBeNull()
  })

  it('PR aberto pelo Jules -> QA', () => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'opened',
        pull_request: { user: { login: 'google-labs-jules[bot]' } },
      })
    ).toBe('qa')
  })

  it('PR aberto por humano -> nada', () => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'opened',
        pull_request: { user: { login: 'loureng' } },
      })
    ).toBeNull()
  })

  it('evento não mapeado (push) -> nada', () => {
    expect(missionRoleForEvent('push', {})).toBeNull()
  })
})

// Custo real medido em produção: assim que o App foi instalado na organização,
// cada conclusão de CI virou uma missão de QA. Sete missões em quatro minutos,
// todas respondendo "nada a julgar" — e cada uma sobe container e gasta cota
// do motor do cliente. O comentário antigo dizia que acordar sempre era
// "seguro" porque o QA é no-op sem PR; seguro não é o mesmo que barato.
describe('missionRoleForEvent: CI sem PR associado não acorda o QA', () => {
  it('conclusão de CI de um PR ainda acorda o QA', () => {
    expect(
      missionRoleForEvent('check_suite', {
        action: 'completed',
        check_suite: { pull_requests: [{ number: 42 }] },
      })
    ).toBe('qa')
  })

  it('conclusão de CI sem PR nenhum (push direto na branch principal) NÃO acorda o QA', () => {
    expect(
      missionRoleForEvent('check_suite', {
        action: 'completed',
        check_suite: { pull_requests: [] },
      })
    ).toBeNull()
    expect(
      missionRoleForEvent('workflow_run', {
        action: 'completed',
        workflow_run: { pull_requests: [] },
      })
    ).toBeNull()
  })

  it('payload sem a lista de PRs: não inventa trabalho, não acorda', () => {
    expect(missionRoleForEvent('workflow_run', { action: 'completed' })).toBeNull()
  })
})
