/**
 * Merge Conflict Analyzer with Git Diff Extraction
 *
 * Detects merge conflicts in Jules PRs, extracts actual git diff per conflicting file,
 * classifies conflict types, and generates per-file resolution strategy for @jules comment.
 */

import { Octokit } from '@octokit/rest'
import { OpenRouterClient, createOpenRouterClientFromEnv } from './lib/openrouter-client.js'
import { isSecurityAutomationPR } from './lib/pr-eligibility.js'
import { z } from 'zod'
import { execSync } from 'child_process'
import * as fs from 'fs'

// Types
const ConflictFileSchema = z.object({
  file: z.string(),
  conflictType: z.enum(['imports', 'logic', 'config', 'lockfile', 'types', 'unknown']),
  resolution: z.enum(['accept-main', 'accept-jules', 'manual-merge']),
  commands: z.array(z.string()).optional(),
  description: z.string(),
})

const ConflictAnalysisSchema = z.object({
  conflicts: z.array(ConflictFileSchema),
  comment: z.string(),
  hasConflicts: z.boolean(),
})

export type ConflictFile = z.infer<typeof ConflictFileSchema>
export type ConflictAnalysis = z.infer<typeof ConflictAnalysisSchema>

// Configuration
const MAX_DIFF_SIZE = 12000
const CONFLICT_MARKER_START = '<<<<<<< '
const CONFLICT_MARKER_MIDDLE = '======='
const CONFLICT_MARKER_END = '>>>>>>> '

/**
 * Runs a shell command and returns output
 */
function runCmd(cmd: string, options: { cwd?: string; ignoreError?: boolean } = {}): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: options.cwd || process.cwd(),
    }).trim()
  } catch (err: unknown) {
    if (options.ignoreError) {
      return ''
    }
    throw err
  }
}

/**
 * Runs a shell command that may fail, returns stdout/stderr/code
 */
function runCmdWithOutput(
  cmd: string,
  options: { cwd?: string; ignoreError?: boolean } = {}
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd || process.cwd(),
    })
    return { stdout: stdout.trim(), stderr: '', code: 0 }
  } catch (err: unknown) {
    if (options.ignoreError) {
      const execError = err as { stdout?: Buffer; stderr?: Buffer; status?: number }
      return {
        stdout: (execError.stdout || '').toString().trim(),
        stderr: (execError.stderr || '').toString().trim(),
        code: execError.status || 1,
      }
    }
    throw err
  }
}

/**
 * Classifies the type of conflict based on file content and conflict markers
 */
function classifyConflict(filePath: string, conflictContent: string): ConflictFile['conflictType'] {
  const lowerPath = filePath.toLowerCase()

  // Lockfiles
  if (
    lowerPath.includes('lock') ||
    lowerPath.endsWith('yarn.lock') ||
    lowerPath.endsWith('pnpm-lock.yaml') ||
    lowerPath.endsWith('package-lock.json')
  ) {
    return 'lockfile'
  }

  // Config files
  if (
    lowerPath.match(/\.(json|yaml|yml|toml|ini|config|rc)$/) ||
    lowerPath.includes('.github/') ||
    lowerPath.includes('.eslintrc') ||
    lowerPath.includes('.prettierrc') ||
    lowerPath.includes('tsconfig')
  ) {
    return 'config'
  }

  // Type definitions
  if (lowerPath.endsWith('.d.ts') || lowerPath.includes('@types/')) {
    return 'types'
  }

  // Analyze conflict content for imports vs logic
  const hasImports = conflictContent.includes('import ') || conflictContent.includes('require(')
  const hasLogic = conflictContent.match(
    /function|class|const|let|var|=>|if\s*\(|for\s*\(|while\s*\(/
  )

  if (hasImports && !hasLogic) return 'imports'
  if (hasLogic) return 'logic'

  return 'unknown'
}

/**
 * Determines resolution strategy based on conflict type and content
 */
function determineResolution(
  _filePath: string,
  conflictType: ConflictFile['conflictType'],
  _mainContent: string,
  _julesContent: string
): ConflictFile['resolution'] {
  // Lockfiles: always regenerate
  if (conflictType === 'lockfile') return 'manual-merge'

  // Config files: prefer main (base branch) for stability
  if (conflictType === 'config') return 'accept-main'

  // Types: prefer main for consistency
  if (conflictType === 'types') return 'accept-main'

  // Imports: usually safe to accept Jules (new dependencies)
  if (conflictType === 'imports') return 'accept-jules'

  // Logic: needs manual review
  return 'manual-merge'
}

/**
 * Extracts conflict sections from a file with conflict markers
 */
function extractConflicts(
  content: string
): Array<{ main: string; incoming: string; fullSection: string }> {
  const conflicts: Array<{ main: string; incoming: string; fullSection: string }> = []
  const lines = content.split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line) {
      i++
      continue
    }
    if (line.startsWith(CONFLICT_MARKER_START)) {
      const start = i
      let middle = -1
      let end = -1

      // Find middle and end markers
      for (let j = i + 1; j < lines.length; j++) {
        const innerLine = lines[j]
        if (!innerLine) continue
        if (innerLine === CONFLICT_MARKER_MIDDLE && middle === -1) {
          middle = j
        } else if (innerLine.startsWith(CONFLICT_MARKER_END) && middle !== -1) {
          end = j
          break
        }
      }

      if (middle !== -1 && end !== -1) {
        const mainLines = lines.slice(start + 1, middle)
        const incomingLines = lines.slice(middle + 1, end)

        conflicts.push({
          main: mainLines.join('\n'),
          incoming: incomingLines.join('\n'),
          fullSection: lines.slice(start, end + 1).join('\n'),
        })

        i = end + 1
      } else {
        i++
      }
    } else {
      i++
    }
  }

  return conflicts
}

/**
 * Generates a git diff for conflicting files
 */
async function generateConflictDiff(
  prNumber: number,
  baseBranch: string = 'main'
): Promise<{ diff: string; conflictingFiles: string[] }> {
  const originalBranch = runCmd('git branch --show-current') || 'main'
  const prBranch = `pr-${prNumber}`

  try {
    // Fetch PR branch
    runCmd(`git fetch origin pull/${prNumber}/head:${prBranch} --force`)

    // Checkout PR branch
    runCmd(`git checkout ${prBranch}`)

    // Configure git user
    runCmd(`git config user.name "github-actions[bot]"`)
    runCmd(`git config user.email "github-actions[bot]@users.noreply.github.com"`)

    // Attempt merge
    runCmdWithOutput(`git merge origin/${baseBranch} --no-commit --no-ff`, { ignoreError: true })

    // Get conflicting files
    const statusResult = runCmdWithOutput('git status --short')
    const conflictingFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.substring(3).trim())

    // Get full diff
    const diffResult = runCmdWithOutput('git diff')
    let diff = diffResult.stdout

    // Abort merge
    runCmd('git merge --abort', { ignoreError: true })
    runCmd(`git checkout ${originalBranch}`, { ignoreError: true })
    runCmd(`git branch -D ${prBranch}`, { ignoreError: true })

    // Limit diff size
    if (diff.length > MAX_DIFF_SIZE) {
      diff = diff.substring(0, MAX_DIFF_SIZE) + '\n\n[Diff truncated due to size...]'
    }

    return { diff, conflictingFiles }
  } catch (error: unknown) {
    // Cleanup on error
    runCmd('git merge --abort 2>/dev/null || true', { ignoreError: true })
    runCmd(`git checkout ${originalBranch} 2>/dev/null || true`, { ignoreError: true })
    runCmd(`git branch -D ${prBranch} 2>/dev/null || true`, { ignoreError: true })
    throw error
  }
}

/**
 * Reads a file and extracts conflict sections
 */
function readConflictingFile(
  filePath: string
): { main: string; incoming: string; fullContent: string } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const conflicts = extractConflicts(content)

    if (conflicts.length === 0) return null

    // Combine all conflicts
    const mainParts = conflicts.map((c) => c.main).join('\n\n---\n\n')
    const incomingParts = conflicts.map((c) => c.incoming).join('\n\n---\n\n')
    const fullSections = conflicts.map((c) => c.fullSection).join('\n\n---\n\n')

    return { main: mainParts, incoming: incomingParts, fullContent: fullSections }
  } catch {
    return null
  }
}

/**
 * Fetches linked issue from PR body or labels
 */
async function fetchLinkedIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ number: number; title: string; body: string } | null> {
  try {
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    const body = pr.data.body || ''

    // Look for issue references: Closes #123, Fixes #456, etc.
    const issueRefs = body.match(
      /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi
    )

    if (issueRefs) {
      for (const ref of issueRefs) {
        const match = ref.match(/#(\d+)/)
        const issueNumStr = match?.[1]
        if (!issueNumStr) continue
        const issueNum = parseInt(issueNumStr, 10)
        // Use a separate async function to avoid nested try-catch issues
        const issue = await fetchIssueSafely(octokit, owner, repo, issueNum)
        if (issue) {
          const issueData = issue.data as Record<string, unknown>
          const labels = issueData['labels'] as Array<{ name?: string } | string> | undefined
          const labelNames = labels
            ? labels
                .map((l: { name?: string } | string) => (typeof l === 'string' ? l : l.name))
                .filter((n: string | undefined): n is string => Boolean(n))
            : []
          if (labelNames.includes('jules') || labelNames.includes('dependabot')) {
            const issueData = issue.data as Record<string, unknown>
            return {
              number: issueNum,
              title: (issueData['title'] as string) || '',
              body: (issueData['body'] as string) || '',
            }
          }
        }
      }
    }

    // Also check for GHSA ID in PR body
    const ghsaMatch = body.match(/GHSA-[\w-]+/)
    if (ghsaMatch) {
      // Search issues with this GHSA ID
      const issues = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'all',
        labels: 'jules',
        per_page: 50,
      })

      for (const issue of issues.data) {
        if (issue.body?.includes(ghsaMatch[0])) {
          const issueData = issue as Record<string, unknown>
          return {
            number: issueData['number'] as number,
            title: (issueData['title'] as string) || '',
            body: (issueData['body'] as string) || '',
          }
        }
      }
    }

    return null
  } catch (error: unknown) {
    console.warn('Failed to fetch linked issue:', error)
    return null
  }
}

/**
 * Fetches an issue safely, returning null on error
 */
async function fetchIssueSafely(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNum: number
): Promise<{ data: Record<string, unknown> } | null> {
  try {
    return await octokit.rest.issues.get({ owner, repo, issue_number: issueNum })
  } catch {
    return null
  }
}

/**
 * Main conflict analysis function
 */
export async function analyzeConflicts(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  llmClient: OpenRouterClient | null = null
): Promise<ConflictAnalysis> {
  console.log(`Analyzing merge conflicts for PR #${prNumber}...`)

  // Generate conflict diff
  const { diff, conflictingFiles } = await generateConflictDiff(prNumber)

  if (conflictingFiles.length === 0) {
    return { conflicts: [], comment: '', hasConflicts: false }
  }

  console.log(`Conflicting files: ${conflictingFiles.join(', ')}`)

  // Analyze each conflicting file
  const conflicts: ConflictFile[] = []

  for (const file of conflictingFiles) {
    const conflictData = readConflictingFile(file)
    if (!conflictData) continue

    const conflictType = classifyConflict(file, conflictData.fullContent)
    const resolution = determineResolution(
      file,
      conflictType,
      conflictData.main,
      conflictData.incoming
    )

    let commands: string[] = []
    let description = ''

    switch (resolution) {
      case 'accept-main':
        description = `Conflito em \`${file}\` (${conflictType}). Aceitar versão da branch \`main\` (base).`
        commands = [`git checkout origin/main -- ${file}`, `git add ${file}`]
        break
      case 'accept-jules':
        description = `Conflito em \`${file}\` (${conflictType}). Aceitar versão do Jules (PR branch).`
        commands = [`git checkout HEAD -- ${file}`, `git add ${file}`]
        break
      case 'manual-merge':
        if (conflictType === 'lockfile') {
          description = `Conflito de lockfile em \`${file}\`. Regenerar lockfile após merge.`
          commands = [
            `git checkout origin/main -- ${file}`,
            `pnpm install --frozen-lockfile`,
            `git add ${file}`,
          ]
        } else {
          description = `Conflito complexo em \`${file}\` (${conflictType}). Requer merge manual.`
          commands = [
            `# Resolver manualmente os marcadores de conflito em ${file}`,
            `git add ${file}`,
          ]
        }
        break
    }

    conflicts.push({
      file,
      conflictType,
      resolution,
      commands,
      description,
    })
  }

  // Generate @jules comment
  let comment = '@jules Este PR tem conflitos de merge que precisam ser resolvidos.\n\n'

  if (llmClient) {
    try {
      // Fetch linked issue for context
      const linkedIssue = await fetchLinkedIssue(octokit, owner, repo, prNumber)

      const issueContext = linkedIssue
        ? `\n\n**Issue vinculada (#${linkedIssue.number}):** ${linkedIssue.title}\n${linkedIssue.body.substring(0, 2000)}`
        : ''

      const prompt = `Analise os conflitos de merge neste PR criado pelo Jules e gere um comentário para o @jules com instruções EXATAS de como resolver cada conflito.

**Arquivos em conflito:**
${conflicts.map((c) => `- \`${c.file}\` (${c.conflictType}): ${c.resolution}`).join('\n')}

**Diff completo dos conflitos:**
\`\`\`diff
${diff}
\`\`\`${issueContext}

**REGRAS OBRIGATÓRIAS:**
1. O comentário DEVE começar com "@jules" (para acionar o bot)
2. Para CADA arquivo, diga EXATAMENTE qual estratégia: "aceite main", "aceite Jules", ou "merge manual"
3. Para lockfiles: "rode pnpm install --frozen-lockfile após resolver"
4. Seja direto, em Português (PT-BR)
5. NÃO inclua texto de segurança ("User Safety: safe")`

      const response = await llmClient.complete(prompt, { maxTokens: 6000, temperature: 0.1 })
      comment += response
    } catch (error: unknown) {
      console.warn('LLM analysis failed, using fallback:', error)
      comment += generateFallbackComment(conflicts)
    }
  } else {
    comment += generateFallbackComment(conflicts)
  }

  return { conflicts, comment, hasConflicts: true }
}

/**
 * Generates fallback comment without LLM
 */
function generateFallbackComment(conflicts: ConflictFile[]): string {
  let comment = '\n## Resolução de Conflitos\n\n'

  for (const conflict of conflicts) {
    comment += `### \`${conflict.file}\` (${conflict.conflictType})\n\n`
    comment += `${conflict.description}\n\n`

    if (conflict.commands && conflict.commands.length > 0) {
      comment += '**Comandos:**\n\`\`\`bash\n'
      comment += conflict.commands.join('\n')
      comment += '\n\`\`\`\n\n'
    }
  }

  comment +=
    '---\n*Comentário gerado automaticamente pelo pipeline de resolução de conflitos do GitOrch.*'
  return comment
}

/**
 * Posts comment to PR and adds label
 */
export async function postConflictResolutionComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  comment: string
): Promise<void> {
  // Ensure label exists
  await octokit.rest.issues
    .createLabel({
      owner,
      repo,
      name: 'jules-conflict-notified',
      color: 'f1a2b3',
      description: 'Notified Jules of merge conflict',
    })
    .catch(() => {}) // Ignore if exists

  // Post comment
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: comment,
  })

  // Add label
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: ['jules-conflict-notified'],
  })

  console.log(`Posted conflict resolution comment on PR #${prNumber}`)
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2)
  const prNumber = args[0] ? parseInt(args[0], 10) : null

  const env = process.env as Record<string, string | undefined>
  const owner = env['REPO_OWNER'] || 'loureng'
  const repo = env['REPO_NAME'] || 'gitorch'
  const githubToken = env['SECURITY_PAT'] || env['GITHUB_TOKEN']

  if (!githubToken) {
    console.error('SECURITY_PAT or GITHUB_TOKEN environment variable is required')
    process.exit(1)
  }

  const octokit = new Octokit({ auth: githubToken })
  const llmClient = env['OPENROUTER_API_KEY'] ? createOpenRouterClientFromEnv() : null

  if (prNumber) {
    // Só age em PR desta automação de segurança (Dependabot/Jules).
    if (!(await isSecurityAutomationPR(octokit, owner, repo, prNumber))) {
      console.log(`PR #${prNumber} fora da automação de segurança. Ignorando.`)
      return
    }
    const analysis = await analyzeConflicts(octokit, owner, repo, prNumber, llmClient)
    if (analysis.hasConflicts) {
      await postConflictResolutionComment(octokit, owner, repo, prNumber, analysis.comment)
      console.log('Conflict analysis complete. Comment posted.')
    } else {
      console.log('No conflicts detected.')
    }
  } else {
    // Varredura: todos os PRs abertos desta automação (usado quando a main move).
    const prs = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 100,
    })

    const julesPRs: typeof prs.data = []
    for (const pr of prs.data) {
      if (await isSecurityAutomationPR(octokit, owner, repo, pr.number)) julesPRs.push(pr)
    }

    console.log(`Found ${julesPRs.length} PRs da automação para checar`)

    for (const pr of julesPRs) {
      try {
        const analysis = await analyzeConflicts(octokit, owner, repo, pr.number, llmClient)
        if (analysis.hasConflicts) {
          await postConflictResolutionComment(octokit, owner, repo, pr.number, analysis.comment)
        } else if (
          pr.labels.some((l) => (typeof l === 'string' ? l : l.name) === 'jules-conflict-notified')
        ) {
          // Remove label if conflicts resolved
          await octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: pr.number,
            name: 'jules-conflict-notified',
          })
          console.log(`Removed conflict label from PR #${pr.number} (now mergeable)`)
        }
      } catch (error: unknown) {
        console.error(`Error processing PR #${pr.number}:`, error)
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
