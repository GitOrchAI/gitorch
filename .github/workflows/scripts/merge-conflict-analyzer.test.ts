import { describe, test, expect } from 'vitest'
import { MergeConflictAnalyzer } from './merge-conflict-analyzer'

describe('MergeConflictAnalyzer', () => {
  describe('parseConflictMarkers', () => {
    test('parses a simple conflict', () => {
      const content = `line 1
<<<<<<< HEAD
ours content
=======
theirs content
>>>>>>> branch
line 2`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].oursContent).toBe('ours content')
      expect(conflicts[0].theirsContent).toBe('theirs content')
      expect(conflicts[0].fullConflict).toContain('<<<<<<< HEAD')
      expect(conflicts[0].fullConflict).toContain('>>>>>>> branch')
    })

    test('parses multiple conflicts in one file', () => {
      const content = `<<<<<<< HEAD
first ours
=======
first theirs
>>>>>>> branch
middle
<<<<<<< HEAD
second ours
=======
second theirs
>>>>>>> branch`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(2)
      expect(conflicts[0].oursContent).toBe('first ours')
      expect(conflicts[0].theirsContent).toBe('first theirs')
      expect(conflicts[1].oursContent).toBe('second ours')
      expect(conflicts[1].theirsContent).toBe('second theirs')
    })

    test('returns empty array for content without conflicts', () => {
      const content = `line 1
line 2
line 3`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(0)
    })

    test('handles empty ours or theirs sections', () => {
      const content = `<<<<<<< HEAD
=======
theirs only
>>>>>>> branch`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].oursContent).toBe('')
      expect(conflicts[0].theirsContent).toBe('theirs only')
    })

    test('handles multiline conflict content', () => {
      const content = `<<<<<<< HEAD
line 1
line 2
line 3
=======
line A
line B
>>>>>>> branch`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].oursContent).toBe('line 1\nline 2\nline 3')
      expect(conflicts[0].theirsContent).toBe('line A\nline B')
    })

    test('handles conflict markers at start of file', () => {
      const content = `<<<<<<< HEAD
start
=======
other start
>>>>>>> branch
rest of file`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].oursStart).toBe(0)
    })

    test('ignores incomplete conflict markers', () => {
      const content = `<<<<<<< HEAD
no divider
no end`

      const conflicts = MergeConflictAnalyzer.parseConflictMarkers(content)

      expect(conflicts).toHaveLength(0)
    })
  })

  describe('analyzeConflicts', () => {
    test('analyzes multiple files with conflicts', () => {
      const files = new Map<string, string>([
        [
          'package.json',
          `{
  "name": "test",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> branch
}`,
        ],
        [
          'src/index.ts',
          `<<<<<<< HEAD
export const a = 1;
=======
export const a = 2;
>>>>>>> branch
`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)

      expect(analysis.hasConflicts).toBe(true)
      expect(analysis.conflictedFiles).toHaveLength(2)
      expect(analysis.totalConflicts).toBe(2)
    })

    test('returns empty analysis for files without conflicts', () => {
      const files = new Map<string, string>([
        ['file1.ts', 'export const a = 1;'],
        ['file2.ts', 'export const b = 2;'],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)

      expect(analysis.hasConflicts).toBe(false)
      expect(analysis.conflictedFiles).toHaveLength(0)
      expect(analysis.totalConflicts).toBe(0)
    })

    test('handles empty file map', () => {
      const files = new Map<string, string>()

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)

      expect(analysis.hasConflicts).toBe(false)
      expect(analysis.conflictedFiles).toHaveLength(0)
    })
  })

  describe('generateFileStrategies', () => {
    test('recommends reinstall-dependencies for package.json', () => {
      const files = new Map<string, string>([
        [
          'package.json',
          `{
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> branch
}`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const pkgStrategy = analysis.fileStrategies.find((s) => s.filePath === 'package.json')

      expect(pkgStrategy).toBeDefined()
      expect(pkgStrategy!.strategy).toBe('reinstall-dependencies')
      expect(pkgStrategy!.commands).toContain('pnpm install')
    })

    test('recommends reinstall-dependencies for pnpm-lock.yaml', () => {
      const files = new Map<string, string>([
        [
          'pnpm-lock.yaml',
          `lockfileVersion: '6.0'
<<<<<<< HEAD
packages:
  /foo: 1.0.0
=======
packages:
  /foo: 2.0.0
>>>>>>> branch
`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const lockStrategy = analysis.fileStrategies.find((s) => s.filePath === 'pnpm-lock.yaml')

      expect(lockStrategy).toBeDefined()
      expect(lockStrategy!.strategy).toBe('reinstall-dependencies')
      expect(lockStrategy!.commands).toContain('pnpm install --frozen-lockfile')
    })

    test('recommends manual-merge for source files', () => {
      const files = new Map<string, string>([
        [
          'src/main.ts',
          `<<<<<<< HEAD
function foo() { return 1; }
=======
function foo() { return 2; }
>>>>>>> branch
`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const srcStrategy = analysis.fileStrategies.find((s) => s.filePath === 'src/main.ts')

      expect(srcStrategy).toBeDefined()
      expect(srcStrategy!.strategy).toBe('manual-merge')
    })

    test('recommends manual-merge for workflow files', () => {
      const files = new Map<string, string>([
        [
          '.github/workflows/ci.yml',
          `name: CI
<<<<<<< HEAD
on: [push]
=======
on: [push, pull_request]
>>>>>>> branch
`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const workflowStrategy = analysis.fileStrategies.find(
        (s) => s.filePath === '.github/workflows/ci.yml'
      )

      expect(workflowStrategy).toBeDefined()
      expect(workflowStrategy!.strategy).toBe('manual-merge')
    })

    test('recommends accept-theirs for whitespace-only conflicts', () => {
      const files = new Map<string, string>([
        [
          'config.json',
          `{
<<<<<<< HEAD
  "key": "value"
=======
  "key": "value"
>>>>>>> branch
}`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const configStrategy = analysis.fileStrategies.find((s) => s.filePath === 'config.json')

      expect(configStrategy).toBeDefined()
      expect(configStrategy!.strategy).toBe('accept-theirs')
    })
  })

  describe('createJulesTaskTemplate', () => {
    test('generates task with @jules mention', () => {
      const files = new Map<string, string>([
        [
          'package.json',
          `{
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> branch
}`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const template = MergeConflictAnalyzer.createJulesTaskTemplate(analysis, {
        prNumber: 123,
        branchName: 'dependabot/npm/lodash-4.17.21',
        packageName: 'lodash',
        targetVersion: '4.17.21',
        repository: 'owner/repo',
        failedRunUrl: 'https://github.com/owner/repo/actions/runs/456',
      })

      expect(template.task).toContain('@jules')
      expect(template.task).toContain('PR #123')
      expect(template.task).toContain('dependabot/npm/lodash-4.17.21')
      expect(template.task).toContain('lodash')
      expect(template.task).toContain('4.17.21')
      expect(template.task).toContain('owner/repo')
      expect(template.task).toContain('https://github.com/owner/repo/actions/runs/456')
    })

    test('includes conflict summary in task', () => {
      const files = new Map<string, string>([
        ['file1.ts', '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n'],
        ['file2.ts', '<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> branch\n'],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const template = MergeConflictAnalyzer.createJulesTaskTemplate(analysis)

      expect(template.conflictSummary).toContain('Total conflicted files: 2')
      expect(template.conflictSummary).toContain('Total conflict regions: 2')
      expect(template.conflictSummary).toContain('file1.ts')
      expect(template.conflictSummary).toContain('file2.ts')
    })

    test('includes per-file strategies table', () => {
      const files = new Map<string, string>([
        [
          'package.json',
          `{
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> branch
}`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const template = MergeConflictAnalyzer.createJulesTaskTemplate(analysis)

      expect(template.task).toContain('| File | Strategy | Conflicts | Commands | Reason |')
      expect(template.task).toContain('package.json')
      expect(template.task).toContain('reinstall-dependencies')
      expect(template.task).toContain('pnpm install')
    })

    test('includes formatted conflict diffs', () => {
      const files = new Map<string, string>([
        [
          'src/test.ts',
          `<<<<<<< HEAD
const x = 1;
=======
const x = 2;
>>>>>>> branch
`,
        ],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const template = MergeConflictAnalyzer.createJulesTaskTemplate(analysis)

      expect(template.conflictDiffs).toContain('#### `src/test.ts`')
      expect(template.conflictDiffs).toContain('```diff')
      expect(template.conflictDiffs).toContain('<<<<<<< HEAD (ours)')
      expect(template.conflictDiffs).toContain('const x = 1;')
      expect(template.conflictDiffs).toContain('=======')
      expect(template.conflictDiffs).toContain('const x = 2;')
      expect(template.conflictDiffs).toContain('>>>>>>> incoming (theirs)')
    })

    test('handles no conflicts gracefully', () => {
      const files = new Map<string, string>([['file.ts', 'export const a = 1;']])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)
      const template = MergeConflictAnalyzer.createJulesTaskTemplate(analysis)

      expect(template.conflictSummary).toContain('No merge conflicts detected')
      expect(template.conflictDiffs).toContain('No conflicts to display')
    })
  })

  describe('strategy reasoning', () => {
    test('generates appropriate reason for each strategy', () => {
      const files = new Map<string, string>([
        ['pkg.json', '<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> branch\n'],
        ['lock.yaml', '<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> branch\n'],
        ['src.ts', '<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> branch\n'],
        ['ws.yml', '<<<<<<< HEAD\n1\n=======\n1\n>>>>>>> branch\n'],
      ])

      const analysis = MergeConflictAnalyzer.analyzeConflicts(files)

      for (const strategy of analysis.fileStrategies) {
        expect(strategy.reason).toBeTruthy()
        expect(strategy.reason.length).toBeGreaterThan(10)
      }
    })
  })
})
