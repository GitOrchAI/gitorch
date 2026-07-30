import { describe, test, expect } from 'vitest'
import { getPlanRepoLimit } from './StepSelectRepos'

describe('StepSelectRepos plan limits', () => {
  test('returns correct repo limit for cloud hosting mode across plans', () => {
    expect(getPlanRepoLimit('free', 'cloud')).toBe(1)
    expect(getPlanRepoLimit('solo', 'cloud')).toBe(2)
    expect(getPlanRepoLimit('pro', 'cloud')).toBe(5)
    expect(getPlanRepoLimit('team', 'cloud')).toBe(15)
  })

  test('returns unlimited repos for VM hosting mode regardless of plan', () => {
    expect(getPlanRepoLimit('free', 'vm')).toBe(Infinity)
    expect(getPlanRepoLimit('solo', 'vm')).toBe(Infinity)
    expect(getPlanRepoLimit('pro', 'vm')).toBe(Infinity)
    expect(getPlanRepoLimit('team', 'vm')).toBe(Infinity)
  })
})
