import { buildAgentMission } from './agent-mission'
import { buildAgentMission as exportedBuildAgentMission } from './index'
import type { RuntimeCredentialRef } from './types'

test('builds a PO mission with default runtime and credential reference', () => {
  const mission = buildAgentMission({
    id: 'mission-po-1',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Normalize externally created issue #42',
    context: ['GitHub is the source of truth', 'Classify issue as Epic, Feature, or Task'],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(mission.runtime).toEqual({ runtime: 'codex' })
  expect(mission.prompt).toContain('Role: po')
  expect(mission.prompt).toContain('Repository: owner/repo')
  expect(mission.prompt).toContain('Normalize externally created issue #42')
  expect(mission.prompt).toContain('GitHub is the source of truth')
})

test('rejects credential/runtime mismatch before execution', () => {
  expect(() =>
    buildAgentMission({
      id: 'mission-ra-1',
      projectId: 'project-1',
      repository: 'owner/repo',
      role: 'ra',
      goal: 'Read project docs',
      context: [],
      credentialRef: {
        connectionId: 'conn-codex',
        ownerScope: 'organization',
        runtime: 'codex',
        providedSecrets: ['OPENAI_API_KEY'],
      },
    })
  ).toThrow('Credential runtime codex does not match selected runtime claude')
})

test('defaults evidence refs and supports matching explicit runtime override', () => {
  const mission = exportedBuildAgentMission({
    id: 'mission-ra-2',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'ra',
    goal: 'Summarize repository context',
    context: [],
    runtime: { runtime: 'codex', model: 'gpt-5', reasoning: 'high' },
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
  })

  expect(mission.runtime).toEqual({ runtime: 'codex', model: 'gpt-5', reasoning: 'high' })
  expect(mission.evidenceRefs).toEqual([])
})

test('keeps credential reference immutable from caller mutations after mission creation', () => {
  const credentialRef: RuntimeCredentialRef = {
    connectionId: 'conn-codex',
    ownerScope: 'project',
    runtime: 'codex',
    providedSecrets: ['OPENAI_API_KEY'],
  }

  const mission = buildAgentMission({
    id: 'mission-po-2',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Prepare project evidence',
    context: [],
    credentialRef,
  })

  credentialRef.providedSecrets.push('MUTATED_SECRET')
  credentialRef.runtime = 'claude'

  expect(mission.credentialRef).toEqual({
    connectionId: 'conn-codex',
    ownerScope: 'project',
    runtime: 'codex',
    providedSecrets: ['OPENAI_API_KEY'],
  })
})

test('propagates userId to buildAgentMission output if provided', () => {
  const mission = buildAgentMission({
    id: 'mission-po-3',
    projectId: 'project-1',
    repository: 'owner/repo',
    role: 'po',
    goal: 'Test user ID propagation',
    context: [],
    credentialRef: {
      connectionId: 'conn-codex',
      ownerScope: 'project',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    },
    userId: 'user-123',
  })

  expect(mission.userId).toBe('user-123')
})
