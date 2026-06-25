import { expect, test } from 'vitest'
import { QueryRewriter } from './rewriter'

const rewriter = new QueryRewriter()

test('QueryRewriter should keep original rawIssue but process it safely', () => {
  const longInput = 'A'.repeat(5000)
  const plan = rewriter.rewrite(longInput)
  expect(plan.rawIssue.length).toBe(5000)
})

test('SNAKE_CASE_REGEX should not suffer from ReDoS', () => {
  const payload = 'a' + '_'.repeat(10000) + 'A'
  const start = Date.now()
  rewriter.rewrite(payload)
  const duration = Date.now() - start
  expect(duration).toBeLessThan(100)
})

test('CAMEL_CASE_REGEX should not suffer from ReDoS', () => {
  const payload = 'a' + 'A'.repeat(10000) + 'a'
  const start = Date.now()
  rewriter.rewrite(payload)
  const duration = Date.now() - start
  expect(duration).toBeLessThan(100)
})

test('DOTTED_NAMESPACE_REGEX should not suffer from ReDoS', () => {
  const payload = 'A.'.repeat(5000) + '!'
  const start = Date.now()
  rewriter.rewrite(payload)
  const duration = Date.now() - start
  expect(duration).toBeLessThan(100)
})

test('FILE_PATH_REGEX should not suffer from ReDoS', () => {
  const payload = 'a/'.repeat(5000) + '!'
  const start = Date.now()
  rewriter.rewrite(payload)
  const duration = Date.now() - start
  expect(duration).toBeLessThan(100)
})

test('SNAKE_CASE_REGEX still matches valid snake_case', () => {
  const issue = 'Fix my_variable and my__variable and trailing_'
  const plan = rewriter.rewrite(issue)
  expect(plan.extractor.entities).toContain('my_variable')
  expect(plan.extractor.entities).toContain('my__variable')
  expect(plan.extractor.entities).toContain('trailing_')
})

test('CAMEL_CASE_REGEX still matches valid camelCase and PascalCase', () => {
  const issue = 'Fix myVariable and MyVariable and ALLCAPS'
  const plan = rewriter.rewrite(issue)
  expect(plan.extractor.entities).toContain('myVariable')
  expect(plan.extractor.entities).toContain('MyVariable')
  expect(plan.extractor.entities).toContain('ALLCAPS')
})
