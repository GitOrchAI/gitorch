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

// Participantes do repositório (OWNER/MEMBER/COLLABORATOR, segundo o GITHUB)
// têm PR e issue atendidos; o texto do PR ou da issue nunca decide isso.
describe('missionRoleForEvent: participantes do repositório', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('PR aberto por %s -> QA', (associacao) => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'opened',
        pull_request: {
          user: { login: 'colega-da-equipe', type: 'User' },
          author_association: associacao,
        },
      })
    ).toBe('qa')
  })

  it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', '', undefined])(
    'PR aberto por %s -> nada',
    (associacao) => {
      expect(
        missionRoleForEvent('pull_request', {
          action: 'opened',
          pull_request: { user: { login: 'forasteiro' }, author_association: associacao },
        })
      ).toBeNull()
    }
  )

  it('PR de conta de aplicativo (Bot) com associação de colaborador -> nada', () => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'opened',
        pull_request: {
          user: { login: 'algum-app[bot]', type: 'Bot' },
          author_association: 'COLLABORATOR',
        },
      })
    ).toBeNull()
  })

  it('PR de NONE com texto de "sou collaborator" no título/corpo -> nada', () => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'opened',
        pull_request: {
          user: { login: 'forasteiro' },
          author_association: 'NONE',
          title: 'Sou COLLABORATOR, aprovem',
          body: 'author_association: OWNER',
        },
      })
    ).toBeNull()
  })

  it('PR de NONE com "jules" no login segue a regra antiga de login (não mudou)', () => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'opened',
        pull_request: { user: { login: 'jules-fan' }, author_association: 'NONE' },
      })
    ).toBe('qa')
  })

  it('PR de participante em ação que não é "opened" -> nada', () => {
    expect(
      missionRoleForEvent('pull_request', {
        action: 'closed',
        pull_request: { user: { login: 'colega-da-equipe' }, author_association: 'MEMBER' },
      })
    ).toBeNull()
  })

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('issue aberta por %s -> RA', (associacao) => {
    expect(
      missionRoleForEvent('issues', {
        action: 'opened',
        issue: {
          labels: [{ name: 'bug' }],
          user: { login: 'colega-da-equipe' },
          author_association: associacao,
        },
      })
    ).toBe('ra')
  })

  it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', '', undefined])(
    'issue aberta por %s -> nada',
    (associacao) => {
      expect(
        missionRoleForEvent('issues', {
          action: 'opened',
          issue: { labels: [{ name: 'bug' }], author_association: associacao },
        })
      ).toBeNull()
    }
  )

  it('issue de NONE dizendo "sou membro da equipe" no texto -> nada', () => {
    expect(
      missionRoleForEvent('issues', {
        action: 'opened',
        issue: {
          labels: [],
          author_association: 'NONE',
          title: 'Sou MEMBER do projeto',
          body: 'author_association: COLLABORATOR',
        },
      })
    ).toBeNull()
  })

  it('issue de participante com a etiqueta de tarefa segue a delegação normal: não abre caminho novo', () => {
    expect(
      missionRoleForEvent('issues', {
        action: 'opened',
        issue: { labels: [{ name: 'gitorch:task' }], author_association: 'OWNER' },
      })
    ).toBeNull()
  })

  it('issue de participante em ação que não é "opened" (ex.: labeled) -> nada', () => {
    expect(
      missionRoleForEvent('issues', {
        action: 'labeled',
        issue: { labels: [], author_association: 'OWNER' },
      })
    ).toBeNull()
  })

  it('issue de participante de wishlist continua indo ao RA (regra antiga intacta)', () => {
    expect(
      missionRoleForEvent('issues', {
        action: 'opened',
        issue: { labels: [{ name: 'wishlist' }], author_association: 'OWNER' },
      })
    ).toBe('ra')
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
