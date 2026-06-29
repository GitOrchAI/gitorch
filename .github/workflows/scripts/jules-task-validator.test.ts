/**
 * Tests for JulesTaskValidator
 */

import { expect, test, describe } from 'vitest'
import { JulesTaskValidator } from './jules-task-validator.js'

describe('JulesTaskValidator', () => {
  describe('validateTaskForJules - Safety Filter Removal', () => {
    test('removes "User Safety: safe" pollution', () => {
      const input = {
        task: 'Fix the build issue. User Safety: safe Please update the dependencies.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('User Safety: safe')
      expect(result.warnings.some((w) => w.includes('User Safety: safe'))).toBe(true)
    })

    test('removes "User Safety: unsafe" pollution', () => {
      const input = {
        task: 'Fix the issue. User Safety: unsafe This needs attention.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('User Safety: unsafe')
      expect(result.warnings.some((w) => w.includes('User Safety: unsafe'))).toBe(true)
    })

    test('removes Portuguese "isso não faz sentido" pollution', () => {
      const input = {
        task: 'Update the package. isso não faz sentido The version is wrong.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('isso não faz sentido')
      expect(result.warnings.some((w) => w.includes('Portuguese'))).toBe(true)
    })

    test('removes "isso nao faz sentido" (without accents)', () => {
      const input = {
        task: 'Fix this. isso nao faz sentido It is broken.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('isso nao faz sentido')
    })

    test('removes multiple safety filter patterns', () => {
      const input = {
        task: 'User Safety: safe Fix it. isso não faz sentido Also User Safety: unsafe please.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('User Safety: safe')
      expect(result.sanitizedTask).not.toContain('User Safety: unsafe')
      expect(result.sanitizedTask).not.toContain('isso não faz sentido')
    })

    test('replaces "unsafe" with "problematic"', () => {
      const input = {
        task: 'This code is unsafe and needs fixing.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).toContain('problematic')
      expect(result.sanitizedTask).not.toContain('unsafe')
    })

    test('replaces "violation" with "issue"', () => {
      const input = {
        task: 'There is a policy violation in the code.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).toContain('issue')
      expect(result.sanitizedTask).not.toContain('violation')
    })

    test('removes "Safety filter triggered" messages', () => {
      const input = {
        task: 'Safety filter triggered. Please fix the code.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('Safety filter triggered')
    })

    test('removes "content policy violation" messages', () => {
      const input = {
        task: 'content policy violation detected. Update the dependencies.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('content policy violation')
    })
  })

  describe('validateTaskForJules - @jules Mention Handling', () => {
    test('adds @jules mention when missing', () => {
      const input = {
        task: 'Fix the failing build please.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.hasJulesMention).toBe(false)
      expect(result.sanitizedTask).toMatch(/^@jules\s/)
    })

    test('preserves existing @jules mention', () => {
      const input = {
        task: '@jules Fix the failing build please.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.hasJulesMention).toBe(true)
      expect(result.sanitizedTask).toBe('@jules Fix the failing build please.')
    })

    test('preserves @Jules mention (case insensitive)', () => {
      const input = {
        task: '@Jules please fix this.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.hasJulesMention).toBe(true)
      expect(result.sanitizedTask).toBe('@Jules please fix this.')
    })

    test('does not duplicate @jules if already present', () => {
      const input = {
        task: '@jules @jules fix this.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).toBe('@jules @jules fix this.')
    })
  })

  describe('validateTaskForJules - Merge Conflict Context', () => {
    test('validates proper merge conflict context', () => {
      const input = {
        task: '@jules Fix the merge conflict in package.json',
        mergeConflictContext: {
          hasConflict: true,
          conflictedFiles: ['package.json', 'yarn.lock'],
          baseBranch: 'main',
          headBranch: 'dependabot/npm/package-1.0.0',
          conflictMarkers: ['<<<<<<< HEAD', '>>>>>>> dependabot'],
        },
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.hasMergeConflictContext).toBe(true)
      expect(result.errors.length).toBe(0)
    })

    test('warns when conflict context provided but no conflict keywords in task', () => {
      const input = {
        task: '@jules Fix the build please.',
        mergeConflictContext: {
          hasConflict: true,
          conflictedFiles: ['package.json'],
          baseBranch: 'main',
          headBranch: 'feature/branch',
        },
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.warnings.some((w) => w.includes('conflict-related keywords'))).toBe(true)
    })

    test('errors when conflict indicated but no conflicted files', () => {
      const input = {
        task: '@jules Fix the merge conflict.',
        mergeConflictContext: {
          hasConflict: true,
          conflictedFiles: [],
          baseBranch: 'main',
          headBranch: 'feature/branch',
        },
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.errors.some((e) => e.includes('no conflicted files'))).toBe(true)
      expect(result.isValid).toBe(false)
    })

    test('errors when baseBranch or headBranch missing', () => {
      const input = {
        task: '@jules Fix the merge conflict.',
        mergeConflictContext: {
          hasConflict: true,
          conflictedFiles: ['package.json'],
          baseBranch: '',
          headBranch: 'feature/branch',
        },
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.errors.some((e) => e.includes('missing baseBranch or headBranch'))).toBe(true)
      expect(result.isValid).toBe(false)
    })

    test('warns when conflict markers provided but not in task', () => {
      const input = {
        task: '@jules Fix the merge conflict please.',
        mergeConflictContext: {
          hasConflict: true,
          conflictedFiles: ['package.json'],
          baseBranch: 'main',
          headBranch: 'feature/branch',
          conflictMarkers: ['<<<<<<< HEAD', '>>>>>>> feature/branch'],
        },
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.warnings.some((w) => w.includes('Conflict markers provided'))).toBe(true)
    })
  })

  describe('validateTaskForJules - Edge Cases', () => {
    test('returns invalid when task becomes empty after sanitization', () => {
      const input = {
        task: 'User Safety: safe isso não faz sentido',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.includes('empty after sanitization'))).toBe(true)
    })

    test('handles task with only whitespace after sanitization', () => {
      const input = {
        task: '   User Safety: safe   ',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.isValid).toBe(false)
    })

    test('cleans up extra whitespace from removals', () => {
      const input = {
        task: 'Fix this.\n\n\nUser Safety: safe\n\n\nPlease help.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.sanitizedTask).not.toContain('\n\n\n')
    })

    test('valid task passes validation', () => {
      const input = {
        task: '@jules Fix the failing CI build for dependabot update.',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.isValid).toBe(true)
      expect(result.errors.length).toBe(0)
    })
  })

  describe('validateTaskForJules - Remaining Safety Triggers', () => {
    test('warns about remaining "User Safety:" prefix', () => {
      const input = {
        task: '@jules User Safety: this is a test task',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.warnings.some((w) => w.includes('Potential safety triggers remain'))).toBe(true)
    })

    test('warns about remaining "safety filter" mention', () => {
      const input = {
        task: '@jules The safety filter blocked this task',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.warnings.some((w) => w.includes('Potential safety triggers remain'))).toBe(true)
    })

    test('warns about remaining "content policy" mention', () => {
      const input = {
        task: '@jules Check the content policy for this',
      }
      const result = JulesTaskValidator.validateTaskForJules(input)
      expect(result.warnings.some((w) => w.includes('Potential safety triggers remain'))).toBe(true)
    })
  })

  describe('createValidatedTask - Factory Method', () => {
    test('creates validated task with all options', () => {
      const result = JulesTaskValidator.createValidatedTask(
        'Fix the merge conflict',
        {
          hasConflict: true,
          conflictedFiles: ['package.json'],
          baseBranch: 'main',
          headBranch: 'feature/branch',
        },
        'feature/branch',
        'owner/repo'
      )
      expect(result.isValid).toBe(true)
      expect(result.sanitizedTask).toContain('@jules')
    })

    test('creates validated task with minimal options', () => {
      const result = JulesTaskValidator.createValidatedTask('Fix the build')
      expect(result.isValid).toBe(true)
      expect(result.sanitizedTask).toContain('@jules Fix the build')
    })
  })
})
