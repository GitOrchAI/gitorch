const { execSync } = require('child_process')
const https = require('https')

// Helper to run shell commands and return output
function runCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    return null
  }
}

// Helper to run shell commands where we expect failure (like git merge with conflicts)
function runCmdWithOutput(cmd) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { stdout: stdout.trim(), stderr: '', code: 0 }
  } catch (error) {
    return {
      stdout: (error.stdout || '').toString().trim(),
      stderr: (error.stderr || '').toString().trim(),
      code: error.status || 1,
    }
  }
}

// Call OpenRouter API
function callOpenRouter(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      return reject(new Error('OPENROUTER_API_KEY environment variable is not set.'))
    }

    const data = JSON.stringify({
      model: 'openrouter/free',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    })

    const options = {
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/loureng/gitorch',
        'X-Title': 'GitOrch Conflict Analyzer',
      },
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (json.choices && json.choices[0] && json.choices[0].message) {
            resolve(json.choices[0].message.content.trim())
          } else {
            reject(new Error(`Invalid response from OpenRouter: ${body}`))
          }
        } catch (e) {
          reject(e)
        }
      })
    })

    req.on('error', (e) => reject(e))
    req.write(data)
    req.end()
  })
}

// Sleep helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Get PR details with retries for mergeable status
async function getPRDetails(prNumber) {
  for (let i = 0; i < 6; i++) {
    console.log(`Checking mergeable status for PR #${prNumber} (attempt ${i + 1}/6)...`)
    const output = runCmd(
      `gh pr view ${prNumber} --json mergeable,mergeStateStatus,body,title,labels`
    )
    if (!output) {
      console.log(`Failed to fetch PR #${prNumber} details.`)
      return null
    }

    try {
      const pr = JSON.parse(output)
      // If status is UNKNOWN, sleep and retry
      if (pr.mergeable === 'UNKNOWN') {
        console.log(`Mergeable status is UNKNOWN. Waiting 5s...`)
        await sleep(5000)
        continue
      }
      return pr
    } catch (e) {
      console.error(`Error parsing PR details JSON:`, e)
      return null
    }
  }
  return null
}

// Process a single PR for conflict analysis
async function processPR(prNumber, prDetails = null) {
  console.log(`\n=== Processing PR #${prNumber} ===`)
  const pr = prDetails || (await getPRDetails(prNumber))
  if (!pr) {
    console.log(`Could not retrieve details for PR #${prNumber}. skipping.`)
    return
  }

  const isJulesPR = pr.body && pr.body.includes('PR created automatically by Jules')
  if (!isJulesPR) {
    console.log(`PR #${prNumber} is not created by Jules. Skipping.`)
    return
  }

  const hasLabel = pr.labels && pr.labels.some((l) => l.name === 'jules-conflict-notified')
  const isConflicting = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'

  console.log(
    `PR #${prNumber} stats: mergeable=${pr.mergeable}, mergeStateStatus=${pr.mergeStateStatus}, hasConflictLabel=${hasLabel}`
  )

  if (!isConflicting) {
    // If it's mergeable now, but has the conflict label, remove it
    if (hasLabel) {
      console.log(
        `PR #${prNumber} is no longer conflicting. Removing 'jules-conflict-notified' label...`
      )
      runCmd(`gh pr edit ${prNumber} --remove-label "jules-conflict-notified"`)
    } else {
      console.log(`PR #${prNumber} is mergeable. Nothing to do.`)
    }
    return
  }

  // If conflicting and already notified, skip
  if (hasLabel) {
    console.log(`PR #${prNumber} is conflicting but has already been notified. Skipping.`)
    return
  }

  console.log(
    `PR #${prNumber} has conflicts and hasn't been notified yet. Generating conflict diff...`
  )

  // Ensure label exists in repo
  runCmd(
    `gh label create jules-conflict-notified --color f1a2b3 --description "Notified Jules of merge conflict" 2>/dev/null || true`
  )

  // Get current branch so we can restore it
  const originalBranch = runCmd(`git branch --show-current`) || 'main'

  try {
    // Fetch and checkout PR branch
    runCmd(`git fetch origin pull/${prNumber}/head:pr-${prNumber} --force`)
    runCmd(`git checkout pr-${prNumber}`)

    // Configure temporary git user
    runCmd(`git config user.name "github-actions[bot]"`)
    runCmd(`git config user.email "github-actions[bot]@users.noreply.github.com"`)

    // Attempt merge
    console.log(`Merging origin/main into pr-${prNumber}...`)
    const mergeResult = runCmdWithOutput(`git merge origin/main --no-commit --no-ff`)

    // Get the conflict diff
    const diffResult = runCmdWithOutput(`git diff`)
    let conflictDiff = diffResult.stdout

    // Abort merge and restore original branch
    runCmd(`git merge --abort`)
    runCmd(`git checkout ${originalBranch}`)
    runCmd(`git branch -D pr-${prNumber} || true`)

    if (!conflictDiff) {
      console.log(`Could not generate conflict diff. Using git status list of unmerged files...`)
      // Fallback: just get list of conflicting files
      runCmd(`git checkout pr-${prNumber}`)
      runCmd(`git merge origin/main --no-commit --no-ff`)
      const statusResult = runCmdWithOutput(`git status --short`)
      conflictDiff = statusResult.stdout
      runCmd(`git merge --abort`)
      runCmd(`git checkout ${originalBranch}`)
      runCmd(`git branch -D pr-${prNumber} || true`)
    }

    // Limit diff size to avoid token limit
    if (conflictDiff.length > 8000) {
      conflictDiff = conflictDiff.substring(0, 8000) + '\n\n[Diff truncado por tamanho...]'
    }

    console.log(`Sending conflict to OpenRouter for analysis...`)
    const prompt = `Analise o seguinte conflito de mesclagem (merge conflict) neste Pull Request criado pelo Jules.
Explique de forma super concisa e direta quais arquivos estão em conflito e qual é o problema.
Em seguida, peça para o @jules resolver o conflito.

IMPORTANTE:
1. Comece ou inclua claramente a menção '@jules' no comentário para acionar o robô.
2. Seja direto e fale em Português (PT-BR).

Conflitos:\n\`\`\`diff\n${conflictDiff}\n\`\`\``

    const response = await callOpenRouter(prompt)
    console.log(`LLM Response:\n${response}`)

    // Comment on PR
    console.log(`Commenting on PR #${prNumber}...`)
    // Escape quotes and backticks for bash argument safely.
    // Instead of raw shell execution with double quotes where bash might interpret characters,
    // we can use fs.writeFileSync and run a command to read from it, or pass via env, or write to a temp file and use gh pr comment -F.
    // That is MUCH safer and prevents bash escaping issues!
    const fs = require('fs')
    const path = require('path')
    const tempFilePath = path.join(__dirname, `pr_comment_${prNumber}.txt`)
    fs.writeFileSync(tempFilePath, response, 'utf8')

    runCmd(`gh pr comment ${prNumber} --body-file "${tempFilePath}"`)
    fs.unlinkSync(tempFilePath)

    // Add label
    console.log(`Adding 'jules-conflict-notified' label...`)
    runCmd(`gh pr edit ${prNumber} --add-label "jules-conflict-notified"`)

    console.log(`PR #${prNumber} processed successfully.`)
  } catch (error) {
    console.error(`Error processing merge conflict for PR #${prNumber}:`, error)
    // Cleanup just in case
    runCmd(`git merge --abort 2>/dev/null || true`)
    runCmd(`git checkout ${originalBranch} 2>/dev/null || true`)
    runCmd(`git branch -D pr-${prNumber} 2>/dev/null || true`)
  }
}

// Main execution function
async function main() {
  const prNumberArg = process.argv[2]

  if (prNumberArg) {
    const prNumber = parseInt(prNumberArg, 10)
    if (isNaN(prNumber)) {
      console.error(`Invalid PR number argument: ${prNumberArg}`)
      process.exit(1)
    }
    await processPR(prNumber)
  } else {
    console.log('No specific PR number provided. Scanning all open PRs...')
    const output = runCmd(
      `gh pr list --json number,mergeable,mergeStateStatus,body,title,labels --limit 100`
    )
    if (!output) {
      console.log('No open PRs found or failed to list PRs.')
      process.exit(0)
    }

    try {
      const prs = JSON.parse(output)
      const julesPRs = prs.filter(
        (pr) => pr.body && pr.body.includes('PR created automatically by Jules')
      )
      console.log(`Found ${julesPRs.length} open PRs created by Jules.`)

      for (const pr of julesPRs) {
        await processPR(pr.number, null)
      }
    } catch (e) {
      console.error('Error listing and parsing PRs:', e)
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
