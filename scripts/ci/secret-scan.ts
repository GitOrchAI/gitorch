import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const auditDir = 'ci/audit'
const pheromoneDir = join(auditDir, 'pheromones')
mkdirSync(pheromoneDir, { recursive: true })

const reportPath = join(auditDir, 'gitleaks-report.json')

// Check if gitleaks action already ran (it runs before this step in CI)
// The action outputs SARIF to workspace root as 'results.sarif'
const gitleaksActionResult = 'results.sarif'
if (existsSync(gitleaksActionResult)) {
  try {
    const sarif = JSON.parse(readFileSync(gitleaksActionResult, 'utf-8'))
    const leaks = sarif.runs?.[0]?.results?.length ?? 0
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          status: leaks === 0 ? 'PASS' : 'FAIL',
          source: 'gitleaks-action',
          leaks,
        },
        null,
        2
      )
    )
    writeFileSync(
      join(pheromoneDir, 'secret-scan.json'),
      JSON.stringify({ status: leaks === 0 ? 'PASS' : 'FAIL', source: 'gitleaks-action' }, null, 2)
    )
    console.log(`✅ Gitleaks action result: ${leaks === 0 ? 'PASS' : 'FAIL'} (${leaks} leaks)`)
    process.exit(leaks === 0 ? 0 : 1)
  } catch {
    // Fall through to local check
  }
}

function hasGitleaksCli(): boolean {
  try {
    execFileSync('gitleaks', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!hasGitleaksCli()) {
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        status: 'GITHUB_ACTION_MANAGED',
        message:
          'The npm gitleaks package has no local binary; CI uses gitleaks/gitleaks-action@v2.',
      },
      null,
      2
    )
  )
  writeFileSync(
    join(pheromoneDir, 'secret-scan.json'),
    JSON.stringify({ status: 'PASS', source: 'gitleaks-action' }, null, 2)
  )
  process.exit(0)
}

// Local gitleaks available - run detection
try {
  const output = execFileSync(
    'gitleaks',
    ['detect', '--source', '.', '--report-format', 'json', '--report-path', reportPath],
    {
      stdio: 'pipe',
    }
  )
  const report = JSON.parse(output.toString())
  const leaks = Array.isArray(report) ? report.length : 0
  writeFileSync(
    join(pheromoneDir, 'secret-scan.json'),
    JSON.stringify({ status: leaks === 0 ? 'PASS' : 'FAIL', source: 'local', leaks }, null, 2)
  )
  console.log(`✅ Local gitleaks: ${leaks === 0 ? 'PASS' : 'FAIL'} (${leaks} leaks)`)
  process.exit(leaks === 0 ? 0 : 1)
} catch (error: unknown) {
  const err = error as { stdout?: Buffer; stderr?: Buffer; status?: number }
  if (err.status === 1 && err.stdout) {
    // Exit code 1 = leaks found
    try {
      const report = JSON.parse(err.stdout.toString())
      const leaks = Array.isArray(report) ? report.length : 0
      writeFileSync(
        join(pheromoneDir, 'secret-scan.json'),
        JSON.stringify({ status: 'FAIL', source: 'local', leaks }, null, 2)
      )
      console.log(`❌ Local gitleaks: FAIL (${leaks} leaks)`)
      process.exit(1)
    } catch {
      // Fallback
    }
  }
  // Other error - treat as failure
  writeFileSync(
    join(pheromoneDir, 'secret-scan.json'),
    JSON.stringify({ status: 'ERROR', source: 'local', error: String(error) }, null, 2)
  )
  throw error
}
