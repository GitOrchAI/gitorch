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
