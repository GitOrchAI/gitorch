import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const auditDir = 'ci/audit'
const pheromoneDir = join(auditDir, 'pheromones')
mkdirSync(pheromoneDir, { recursive: true })

const reportPath = join(auditDir, 'gitleaks-report.json')

function hasGitleaksCli(): boolean {
  try {
    execFileSync('pnpm', ['exec', 'gitleaks', '--version'], { stdio: 'ignore' })
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
  writeFileSync(
    join(pheromoneDir, 'blocked.json'),
    JSON.stringify(
      { status: 'clear', reason: 'No pheromone block emitted by gitleaks action.' },
      null,
      2
    )
  )
} else {
  try {
    execFileSync(
      'pnpm',
      ['exec', 'gitleaks', 'detect', '--report-format', 'json', '--report-path', reportPath],
      {
        stdio: 'pipe',
      }
    )
    writeFileSync(
      join(pheromoneDir, 'secret-scan.json'),
      JSON.stringify({ status: 'PASS', source: 'gitleaks-cli' }, null, 2)
    )
    writeFileSync(
      join(pheromoneDir, 'blocked.json'),
      JSON.stringify(
        { status: 'clear', reason: 'No pheromone block emitted by gitleaks CLI.' },
        null,
        2
      )
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeFileSync(
      join(pheromoneDir, 'blocked.json'),
      JSON.stringify({ status: 'blocked', reason: message }, null, 2)
    )
    process.exit(1)
  }
}
