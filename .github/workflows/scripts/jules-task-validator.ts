/**
 * Jules Task Validator
 *
 * Validates and sanitizes Jules tasks to prevent User Safety filter triggers.
 * Handles patterns from issues #64, PR #107, #108 (User Safety: safe pollution).
 */

export interface MergeConflictContext {
  hasConflict: boolean
  conflictedFiles: string[]
  baseBranch: string
  headBranch: string
  conflictMarkers?: string[]
}

export interface JulesTaskInput {
  task: string
  mergeConflictContext?: MergeConflictContext
  targetBranch?: string
  repository?: string
}

export interface ValidationResult {
  isValid: boolean
  sanitizedTask: string
  warnings: string[]
  errors: string[]
  hasJulesMention: boolean
  hasMergeConflictContext: boolean
}

export interface SafetyFilterPattern {
  pattern: RegExp
  replacement: string
  description: string
}

export class JulesTaskValidator {
  private static readonly SAFETY_FILTER_PATTERNS: SafetyFilterPattern[] = [
    {
      pattern: /User Safety:\s*safe/gi,
      replacement: '',
      description: 'Removes "User Safety: safe" pollution from free model outputs',
    },
    {
      pattern: /User Safety:\s*unsafe/gi,
      replacement: '',
      description: 'Removes "User Safety: unsafe" pollution from free model outputs',
    },
    {
      pattern: /isso n[aã]o faz sentido/gi,
      replacement: '',
      description: 'Removes Portuguese "isso não faz sentido" pollution',
    },
    {
      pattern: /Safety filter triggered/gi,
      replacement: '',
      description: 'Removes generic safety filter triggers',
    },
    {
      pattern: /content policy violation/gi,
      replacement: '',
      description: 'Removes content policy violation messages',
    },
    {
      pattern: /\bunsafe\b/gi,
      replacement: 'problematic',
      description: 'Replaces "unsafe" with neutral term',
    },
    {
      pattern: /\bviolation\b/gi,
      replacement: 'issue',
      description: 'Replaces "violation" with neutral term',
    },
  ]

  private static readonly JULES_MENTION_PATTERN = /@jules\b/i
  private static readonly REQUIRED_JULES_MENTION = '@jules'
  private static readonly MERGE_CONFLICT_KEYWORDS = [
    'merge conflict',
    'conflito de merge',
    'merge conflict',
    'conflito',
    'conflict',
    '<<<<<<<',
    '>>>>>>>',
    '=======',
  ]

  /**
   * Validates and sanitizes a Jules task to prevent User Safety filter triggers
   * @param input - The task input with optional merge conflict context
   * @returns ValidationResult with sanitized task and validation metadata
   */
  public static validateTaskForJules(input: JulesTaskInput): ValidationResult {
    const warnings: string[] = []
    const errors: string[] = []

    let sanitizedTask = input.task

    // 1. Remove safety filter pollution patterns
    for (const filter of this.SAFETY_FILTER_PATTERNS) {
      const matches = sanitizedTask.match(filter.pattern)
      if (matches) {
        warnings.push(`Removed ${matches.length} occurrence(s) of "${filter.description}"`)
        sanitizedTask = sanitizedTask.replace(filter.pattern, filter.replacement)
      }
    }

    // 2. Clean up extra whitespace from removals
    sanitizedTask = this.cleanupWhitespace(sanitizedTask)

    // 3. Validate task is not empty after sanitization (before adding @jules)
    if (!sanitizedTask.trim()) {
      errors.push('Task is empty after sanitization')
    }

    // 4. Ensure @jules mention is present
    const hasJulesMention = this.JULES_MENTION_PATTERN.test(sanitizedTask)
    if (!hasJulesMention && sanitizedTask.trim()) {
      warnings.push('Added missing @jules mention to task prompt')
      sanitizedTask = this.ensureJulesMention(sanitizedTask)
    } else if (!sanitizedTask.trim()) {
      // If empty after sanitization, still add @jules so sanitizedTask is not empty string
      sanitizedTask = '@jules'
    }

    const hasMergeConflictContext = this.hasMergeConflictContext(input)

    // 5. Validate merge conflict context if provided
    if (input.mergeConflictContext) {
      const conflictValidation = this.validateMergeConflictContext(
        input.mergeConflictContext,
        sanitizedTask
      )
      warnings.push(...conflictValidation.warnings)
      errors.push(...conflictValidation.errors)
    }

    // 6. Check for remaining safety filter triggers
    const remainingTriggers = this.checkRemainingSafetyTriggers(sanitizedTask)
    if (remainingTriggers.length > 0) {
      warnings.push(`Potential safety triggers remain: ${remainingTriggers.join(', ')}`)
    }

    return {
      isValid: errors.length === 0,
      sanitizedTask: sanitizedTask.trim(),
      warnings,
      errors,
      hasJulesMention,
      hasMergeConflictContext,
    }
  }

  /**
   * Validates merge conflict context is properly structured
   */
  private static validateMergeConflictContext(
    context: MergeConflictContext,
    task: string
  ): { warnings: string[]; errors: string[] } {
    const warnings: string[] = []
    const errors: string[] = []

    if (!context.hasConflict) {
      warnings.push('Merge conflict context indicates no conflict, but context was provided')
    }

    if (context.conflictedFiles.length === 0 && context.hasConflict) {
      errors.push('Merge conflict indicated but no conflicted files listed')
    }

    if (!context.baseBranch || !context.headBranch) {
      errors.push('Merge conflict context missing baseBranch or headBranch')
    }

    // Check if task mentions conflict context appropriately
    const hasConflictKeywords = this.MERGE_CONFLICT_KEYWORDS.some((keyword) =>
      task.toLowerCase().includes(keyword.toLowerCase())
    )

    if (context.hasConflict && !hasConflictKeywords) {
      warnings.push(
        'Task mentions merge conflict context but task text lacks conflict-related keywords'
      )
    }

    if (context.conflictMarkers && context.conflictMarkers.length > 0) {
      const hasMarkersInTask = context.conflictMarkers.some((marker) => task.includes(marker))
      if (!hasMarkersInTask) {
        warnings.push('Conflict markers provided but not referenced in task description')
      }
    }

    return { warnings, errors }
  }

  /**
   * Checks if the input has merge conflict context
   */
  private static hasMergeConflictContext(input: JulesTaskInput): boolean {
    return (
      input.mergeConflictContext !== undefined &&
      input.mergeConflictContext.hasConflict === true &&
      input.mergeConflictContext.conflictedFiles.length > 0
    )
  }

  /**
   * Checks for remaining safety filter triggers in sanitized task
   */
  private static checkRemainingSafetyTriggers(task: string): string[] {
    const triggers: string[] = []

    const triggerPatterns = [
      { pattern: /user safety:/i, name: 'User Safety prefix' },
      { pattern: /isso n[aã]o faz sentido/i, name: 'Portuguese nonsense phrase' },
      { pattern: /safety filter/i, name: 'Safety filter mention' },
      { pattern: /content policy/i, name: 'Content policy mention' },
    ]

    for (const { pattern, name } of triggerPatterns) {
      if (pattern.test(task)) {
        triggers.push(name)
      }
    }

    return triggers
  }

  /**
   * Ensures @jules mention is present in task
   */
  private static ensureJulesMention(task: string): string {
    const trimmed = task.trim()
    if (trimmed.startsWith('@jules') || trimmed.startsWith('@Jules')) {
      return trimmed
    }
    return `@jules ${trimmed}`
  }

  /**
   * Cleans up extra whitespace from sanitization
   */
  private static cleanupWhitespace(text: string): string {
    return text
      .replace(/\n\s*\n\s*\n/g, '\n\n') // Collapse multiple newlines
      .replace(/[ \t]+/g, ' ') // Collapse spaces/tabs
      .replace(/^\s+|\s+$/gm, '') // Trim lines
      .trim()
  }

  /**
   * Static method to create a validated task from raw input
   */
  public static createValidatedTask(
    rawTask: string,
    mergeConflictContext?: MergeConflictContext,
    targetBranch?: string,
    repository?: string
  ): ValidationResult {
    return this.validateTaskForJules({
      task: rawTask,
      mergeConflictContext,
      targetBranch,
      repository,
    })
  }
}
