import { expect, test } from 'vitest'
import { QueryRewriter } from './rewriter'

const rewriter = new QueryRewriter()

test('rewrites the required separability issue into deterministic anchors', () => {
  const issue =
    'O cálculo da matriz de separabilidade falha em CompoundModels aninhados no astropy.modeling.'
  const plan = rewriter.rewrite(issue)

  expect(plan.rawIssue).toBe(issue)
  expect(plan.extractor.entities).toContain('CompoundModels')
  expect(plan.extractor.entities).toContain('astropy/modeling')
  expect(plan.extractor.entities).toContain('astropy/modeling/separable.py')
  expect(plan.extractor.keywords).toContain('separability_matrix')
  expect(plan.extractor.keywords).toContain('nested')
  expect(plan.extractor.keywords).toContain('recursion')
  expect(plan.inferer.functionalReq).toContain('recurs')
  expect(plan.inferer.behavioralExpectation).toContain('leaf')
})

test('extracts quoted file paths and quoted symbols as entities', () => {
  const issue =
    'Fix quoted path "src/utils/pathHelpers.ts" used by "normalizePath" in nested models.'
  const plan = rewriter.rewrite(issue)

  expect(plan.extractor.entities).toContain('src/utils/pathHelpers.ts')
  expect(plan.extractor.entities).toContain('normalizePath')
  expect(plan.extractor.keywords).toContain('nested')
  expect(plan.extractor.keywords).toContain('recursion')
})

test('turns dotted namespaces into slash paths and keeps namespace keywords', () => {
  const issue =
    'pkg.module.Class.method should handle nested recursion for pkg.module.Class.method.'
  const plan = rewriter.rewrite(issue)

  expect(plan.extractor.entities).toContain('pkg/module/Class/method')
  expect(plan.extractor.keywords).toContain('pkg.module.Class.method')
  expect(plan.extractor.keywords).toContain('nested')
  expect(plan.extractor.keywords).toContain('recursion')
})
