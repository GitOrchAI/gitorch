/**
 * Merge Conflict Analyzer
 *
 * Analyzes git merge conflicts from Dependabot PR failures and generates
 * structured Jules task templates with per-file action strategies.
 */

export type ConflictStrategy =
  'accept-theirs' | 'accept-ours' | 'manual-merge' | 'reinstall-dependencies'

export interface ConflictMarker {
  oursStart: number
  divider: number
  theirsEnd: number
  oursContent: string
  theirsContent: string
  fullConflict: string
}

export interface FileConflict {
  filePath: string
  conflicts: ConflictMarker[]
  rawContent: string
}

export interface FileStrategy {
  filePath: string
  strategy: ConflictStrategy
  reason: string
  commands: string[]
  conflictCount: number
}

export interface MergeConflictAnalysis {
  conflictedFiles: FileConflict[]
  fileStrategies: FileStrategy[]
  totalConflicts: number
  hasConflicts: boolean
}

export interface JulesTaskTemplate {
  task: string
  conflictSummary: string
  fileStrategies: FileStrategy[]
  conflictDiffs: string
}

const CONFLICT_START = '<<<<<<<'
const CONFLICT_DIVIDER = '======='
const CONFLICT_END = '>>>>>>>'

const FILE_STRATEGY_MAP: Record<string, ConflictStrategy> = {
  'package.json': 'reinstall-dependencies',
  'pnpm-lock.yaml': 'reinstall-dependencies',
  'yarn.lock': 'reinstall-dependencies',
  'package-lock.json': 'reinstall-dependencies',
  'tsconfig.json': 'manual-merge',
  'eslint.config.js': 'manual-merge',
  'prettier.config.js': 'manual-merge',
  '.github/workflows/': 'manual-merge',
}

const FILE_COMMANDS_MAP: Record<string, string[]> = {
  'package.json': ['pnpm install'],
  'pnpm-lock.yaml': ['pnpm install --frozen-lockfile'],
  'yarn.lock': ['yarn install --frozen-lockfile'],
  'package-lock.json': ['npm ci'],
  'tsconfig.json': [],
  'eslint.config.js': [],
  'prettier.config.js': [],
  '.github/workflows/': [],
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function getDirectoryPath(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/') + '/'
}

export class MergeConflictAnalyzer {
  /**
   * Analyzes merge conflicts from file contents
   * @param files - Map of file paths to their content (with conflict markers)
   * @returns MergeConflictAnalysis with parsed conflicts and strategies
   */
  static analyzeConflicts(files: Map<string, string>): MergeConflictAnalysis {
    const conflictedFiles: FileConflict[] = []

    for (const [filePath, content] of files) {
      const conflicts = this.parseConflictMarkers(content)
      if (conflicts.length > 0) {
        conflictedFiles.push({
          filePath,
          conflicts,
          rawContent: content,
        })
      }
    }

    const fileStrategies = this.generateFileStrategies(conflictedFiles)
    const totalConflicts = conflictedFiles.reduce((sum, f) => sum + f.conflicts.length, 0)

    return {
      conflictedFiles,
      fileStrategies,
      totalConflicts,
      hasConflicts: conflictedFiles.length > 0,
    }
  }

  /**
   * Parses git conflict markers from file content
   * @param content - File content with conflict markers
   * @returns Array of ConflictMarker objects
   */
  static parseConflictMarkers(content: string): ConflictMarker[] {
    const conflicts: ConflictMarker[] = []
    const lines = content.split('\n')
    let i = 0

    while (i < lines.length) {
      const line = lines[i]

      if (line.startsWith(CONFLICT_START)) {
        const oursStart = i
        let divider = -1
        let theirsEnd = -1

        // Find the divider (=======)
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith(CONFLICT_DIVIDER)) {
            divider = j
            break
          }
        }

        // Find the end (>>>>>>>)
        if (divider !== -1) {
          for (let j = divider + 1; j < lines.length; j++) {
            if (lines[j].startsWith(CONFLICT_END)) {
              theirsEnd = j
              break
            }
          }
        }

        if (divider !== -1 && theirsEnd !== -1) {
          const oursContent = lines.slice(oursStart + 1, divider).join('\n')
          const theirsContent = lines.slice(divider + 1, theirsEnd).join('\n')
          const fullConflict = lines.slice(oursStart, theirsEnd + 1).join('\n')

          conflicts.push({
            oursStart,
            divider,
            theirsEnd,
            oursContent,
            theirsContent,
            fullConflict,
          })

          i = theirsEnd + 1
          continue
        }
      }
      i++
    }

    return conflicts
  }

  /**
   * Generates per-file action strategies based on conflict content and file type
   * @param conflictedFiles - Array of files with conflicts
   * @returns Array of FileStrategy objects
   */
  static generateFileStrategies(conflictedFiles: FileConflict[]): FileStrategy[] {
    return conflictedFiles.map((file) => {
      const fileName = getFileName(file.filePath)
      const dirPath = getDirectoryPath(file.filePath)

      // Check for exact file name match first
      let strategy = FILE_STRATEGY_MAP[fileName]
      let commands = FILE_COMMANDS_MAP[fileName]

      // Check for directory-based match (e.g., .github/workflows/)
      if (!strategy && dirPath) {
        for (const [pattern, strat] of Object.entries(FILE_STRATEGY_MAP)) {
          if (pattern.endsWith('/') && dirPath === pattern) {
            strategy = strat
            commands = FILE_COMMANDS_MAP[pattern] || []
            break
          }
        }
      }

      // Default strategy based on conflict content analysis
      if (!strategy) {
        strategy = this.determineDefaultStrategy(file)
        commands = this.getDefaultCommands(fileName, strategy)
      }

      const reason = this.generateStrategyReason(fileName, strategy, file.conflicts.length)

      return {
        filePath: file.filePath,
        strategy,
        reason,
        commands,
        conflictCount: file.conflicts.length,
      }
    })
  }

  /**
   * Determines default strategy based on conflict content
   */
  private static determineDefaultStrategy(file: FileConflict): ConflictStrategy {
    const hasOnlyDependencyChanges = file.conflicts.every((conflict) => {
      const ours = conflict.oursContent.toLowerCase()
      const theirs = conflict.theirsContent.toLowerCase()
      return (
        (ours.includes('version') && theirs.includes('version')) ||
        (ours.includes('dependency') && theirs.includes('dependency')) ||
        (ours.match(/^\s*["'][\w\-/]+["']:\s*["'][\d\.\^~]+["']/) &&
          theirs.match(/^\s*["'][\w\-/]+["']:\s*["'][\d\.\^~]+["']/))
      )
    })

    if (hasOnlyDependencyChanges) {
      return 'reinstall-dependencies'
    }

    // Check if conflicts are trivial (whitespace only)
    const hasOnlyWhitespaceConflicts = file.conflicts.every((conflict) => {
      const oursTrimmed = conflict.oursContent.trim()
      const theirsTrimmed = conflict.theirsContent.trim()
      return oursTrimmed === theirsTrimmed
    })

    if (hasOnlyWhitespaceConflicts) {
      return 'accept-theirs'
    }

    return 'manual-merge'
  }

  /**
   * Gets default commands for a file type and strategy
   */
  private static getDefaultCommands(fileName: string, strategy: ConflictStrategy): string[] {
    if (strategy === 'reinstall-dependencies') {
      if (fileName === 'pnpm-lock.yaml') return ['pnpm install --frozen-lockfile']
      if (fileName === 'yarn.lock') return ['yarn install --frozen-lockfile']
      if (fileName === 'package-lock.json') return ['npm ci']
      return ['pnpm install']
    }
    return []
  }

  /**
   * Generates human-readable reason for the strategy
   */
  private static generateStrategyReason(
    fileName: string,
    strategy: ConflictStrategy,
    conflictCount: number
  ): string {
    const base = `${fileName} has ${conflictCount} conflict(s)`
    switch (strategy) {
      case 'accept-theirs':
        return `${base} - accepting incoming changes (whitespace/formatting only)`
      case 'accept-ours':
        return `${base} - keeping current version (local changes take precedence)`
      case 'manual-merge':
        return `${base} - requires manual resolution (code logic changes detected)`
      case 'reinstall-dependencies':
        return `${base} - dependency version conflicts detected, reinstall recommended`
      default:
        return `${base} - strategy: ${strategy}`
    }
  }

  /**
   * Creates a structured Jules task template with conflict diffs injected
   * @param analysis - The merge conflict analysis result
   * @param context - Additional context (PR number, branch, etc.)
   * @returns JulesTaskTemplate with formatted task and conflict details
   */
  static createJulesTaskTemplate(
    analysis: MergeConflictAnalysis,
    context: {
      prNumber?: number
      branchName?: string
      packageName?: string
      targetVersion?: string
      repository?: string
      failedRunUrl?: string
    } = {}
  ): JulesTaskTemplate {
    const { prNumber, branchName, packageName, targetVersion, repository, failedRunUrl } = context

    const conflictSummary = this.generateConflictSummary(analysis)
    const conflictDiffs = this.formatConflictDiffs(analysis)
    const fileStrategiesSummary = this.formatFileStrategies(analysis.fileStrategies)

    const taskLines: string[] = [
      '@jules',
      '',
      `## Merge Conflict Resolution Task`,
      '',
      `**PR #${prNumber || 'N/A'}** ${branchName ? `(branch: \`${branchName}\`)` : ''}`,
      packageName ? `**Package:** \`${packageName}\` → \`${targetVersion || 'latest'}\`` : '',
      repository ? `**Repository:** ${repository}` : '',
      failedRunUrl ? `**Failed CI Run:** ${failedRunUrl}` : '',
      '',
      `### Conflict Summary`,
      conflictSummary,
      '',
      `### Per-File Strategies`,
      fileStrategiesSummary,
      '',
      `### Conflict Diffs`,
      conflictDiffs,
      '',
      `### Instructions`,
      `1. Review each conflicted file and apply the recommended strategy`,
      `2. For \`manual-merge\` files, resolve conflicts preserving both intended changes`,
      `3. For \`reinstall-dependencies\` files, run the specified commands after resolution`,
      `4. For \`accept-theirs\`/\`accept-ours\` files, apply the indicated resolution`,
      `5. Run tests to verify the merge resolution`,
      `6. Commit the resolved changes to the same branch (\`${branchName || 'PR branch'}\`)`,
    ]

    const task = taskLines.filter((line) => line !== '').join('\n')

    return {
      task,
      conflictSummary,
      fileStrategies: analysis.fileStrategies,
      conflictDiffs,
    }
  }

  /**
   * Generates a summary of all conflicts
   */
  private static generateConflictSummary(analysis: MergeConflictAnalysis): string {
    if (!analysis.hasConflicts) {
      return 'No merge conflicts detected.'
    }

    const lines = [
      `Total conflicted files: ${analysis.conflictedFiles.length}`,
      `Total conflict regions: ${analysis.totalConflicts}`,
      '',
      'Conflicted files:',
    ]

    for (const file of analysis.conflictedFiles) {
      lines.push(`- \`${file.filePath}\`: ${file.conflicts.length} conflict(s)`)
    }

    return lines.join('\n')
  }

  /**
   * Formats file strategies as a markdown table
   */
  private static formatFileStrategies(strategies: FileStrategy[]): string {
    const lines = [
      '| File | Strategy | Conflicts | Commands | Reason |',
      '|------|----------|-----------|----------|--------|',
    ]

    for (const s of strategies) {
      const commandsStr = s.commands.length > 0 ? s.commands.join('; ') : '—'
      const reasonEscaped = s.reason.replace(/\|/g, '\\|')
      lines.push(
        `| \`${s.filePath}\` | ${s.strategy} | ${s.conflictCount} | ${commandsStr} | ${reasonEscaped} |`
      )
    }

    return lines.join('\n')
  }

  /**
   * Formats conflict diffs with proper markdown code blocks
   */
  private static formatConflictDiffs(analysis: MergeConflictAnalysis): string {
    if (!analysis.hasConflicts) {
      return 'No conflicts to display.'
    }

    const diffs: string[] = []

    for (const file of analysis.conflictedFiles) {
      diffs.push(`#### \`${file.filePath}\``)
      diffs.push('')

      for (let i = 0; i < file.conflicts.length; i++) {
        const conflict = file.conflicts[i]
        diffs.push(`**Conflict ${i + 1}:**`)
        diffs.push('')
        diffs.push('```diff')
        diffs.push(`<<<<<<< HEAD (ours)`)
        diffs.push(conflict.oursContent || '(empty)')
        diffs.push(`=======`)
        diffs.push(conflict.theirsContent || '(empty)')
        diffs.push(`>>>>>>> incoming (theirs)`)
        diffs.push('```')
        diffs.push('')
      }
    }

    return diffs.join('\n')
  }
}
