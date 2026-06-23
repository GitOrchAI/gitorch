import { expect, test } from 'vitest'
import { DecisionBriefService } from './decision-brief'

test('creates and answers a decision brief', () => {
  const service = new DecisionBriefService()
  const brief = service.request({
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    requestedBy: { id: 'po', role: 'po' },
    question: 'Should this high-impact change be delegated now?',
    options: [
      {
        id: 'approve',
        label: 'Delegate now',
        tradeoff: 'Faster delivery with higher risk.',
        recommended: false,
      },
      {
        id: 'hold',
        label: 'Hold for review',
        tradeoff: 'Slower delivery with lower risk.',
        recommended: true,
      },
    ],
    now: '2026-06-22T10:00:00.000Z',
  })

  const answered = service.answer(brief.id, 'hold', '2026-06-22T10:10:00.000Z')

  expect(brief.status).toBe('open')
  expect(answered.status).toBe('answered')
  expect(answered.answerId).toBe('hold')
})

test('rejects decision briefs with fewer than two options', () => {
  const service = new DecisionBriefService()

  expect(() =>
    service.request({
      scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
      requestedBy: { id: 'po', role: 'po' },
      question: 'Should this high-impact change be delegated now?',
      options: [
        {
          id: 'approve',
          label: 'Delegate now',
          tradeoff: 'Faster delivery with higher risk.',
          recommended: true,
        },
      ],
      now: '2026-06-22T10:00:00.000Z',
    })
  ).toThrow('Decision briefs require at least two options.')
})

test('rejects invalid decision brief and answer IDs', () => {
  const service = new DecisionBriefService()

  const brief = service.request({
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    requestedBy: { id: 'po', role: 'po' },
    question: 'Should this high-impact change be delegated now?',
    options: [
      {
        id: 'approve',
        label: 'Delegate now',
        tradeoff: 'Faster delivery with higher risk.',
        recommended: false,
      },
      {
        id: 'hold',
        label: 'Hold for review',
        tradeoff: 'Slower delivery with lower risk.',
        recommended: true,
      },
    ],
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(() => service.answer('missing', 'hold', '2026-06-22T10:10:00.000Z')).toThrow(
    'Decision brief not found: missing'
  )
  expect(() => service.answer(brief.id, 'reject', '2026-06-22T10:10:00.000Z')).toThrow(
    'Decision option not found: reject'
  )
})

test('open returns only unanswered briefs', () => {
  const service = new DecisionBriefService()
  const first = service.request({
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    requestedBy: { id: 'po', role: 'po' },
    question: 'Should this high-impact change be delegated now?',
    options: [
      { id: 'approve', label: 'Delegate now', tradeoff: 'Faster delivery.', recommended: false },
      { id: 'hold', label: 'Hold for review', tradeoff: 'Lower risk.', recommended: true },
    ],
    now: '2026-06-22T10:00:00.000Z',
  })
  const second = service.request({
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '43' },
    requestedBy: { id: 'po', role: 'po' },
    question: 'Should this be postponed?',
    options: [
      { id: 'ship', label: 'Ship now', tradeoff: 'Faster feedback.', recommended: true },
      { id: 'postpone', label: 'Postpone', tradeoff: 'More analysis.', recommended: false },
    ],
    now: '2026-06-22T10:01:00.000Z',
  })

  service.answer(first.id, 'hold', '2026-06-22T10:10:00.000Z')

  expect(service.open()).toEqual([second])
})

test('returns defensive copies from request answer and open', () => {
  const service = new DecisionBriefService()
  const scope = { type: 'issue' as const, wingId: 'loureng/gitorch', targetId: '42' }
  const requestedBy = { id: 'po', role: 'po' as const }
  const options = [
    { id: 'approve', label: 'Delegate now', tradeoff: 'Faster delivery.', recommended: false },
    { id: 'hold', label: 'Hold for review', tradeoff: 'Lower risk.', recommended: true },
  ]

  const brief = service.request({
    scope,
    requestedBy,
    question: 'Should this high-impact change be delegated now?',
    options,
    now: '2026-06-22T10:00:00.000Z',
  })

  scope.targetId = 'mutated-scope'
  requestedBy.id = 'mutated-owner'
  options[0]!.label = 'Mutated option'
  brief.scope.targetId = 'mutated-return-scope'
  brief.requestedBy.id = 'mutated-return-owner'
  brief.options[0]!.label = 'Mutated return option'

  const opened = service.open()
  opened[0]!.scope.targetId = 'mutated-open-scope'
  opened[0]!.options[0]!.label = 'Mutated open option'

  const answered = service.answer(brief.id, 'hold', '2026-06-22T10:10:00.000Z')
  answered.scope.targetId = 'mutated-answer-scope'
  answered.options[0]!.label = 'Mutated answer option'

  expect(service.answer(brief.id, 'hold', '2026-06-22T10:11:00.000Z')).toMatchObject({
    scope: { targetId: '42' },
    requestedBy: { id: 'po' },
    options: [{ label: 'Delegate now' }, { label: 'Hold for review' }],
  })
})
