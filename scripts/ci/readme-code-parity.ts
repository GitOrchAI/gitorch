import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type ImplementedClaim = {
  label: string
  evidencePath: string
  evidenceCheck: (content: string) => boolean
}

const implementedClaims: ImplementedClaim[] = [
  {
    label: 'F0: Foundation',
    evidencePath: 'package.json',
    evidenceCheck: (content) =>
      content.includes('"build"') && content.includes('"test"') && content.includes('"lint"'),
  },
  {
    label: 'F1: CodeSight Core',
    evidencePath: 'packages/cgc/src/index.ts',
    evidenceCheck: (content) =>
      content.includes('CodeGraphIndexer') && content.includes('TreeSitterManager'),
  },
  {
    label: 'F2: Cortex 4-Layer',
    evidencePath: 'packages/cortex/src/index.ts',
    evidenceCheck: (content) =>
      content.includes('CortexClient') && content.includes('ChromaSemanticStore'),
  },
]

export function checkImplementedClaims(): string[] {
  const readme = readFileSync('README.md', 'utf8')
  const missing: string[] = []

  for (const claim of implementedClaims) {
    const claimLine = readme.match(
      new RegExp(`\\[x\\]\\s+\\*\\*${escapeRegExp(claim.label)}\\*\\*`)
    )
    if (!claimLine) {
      continue
    }

    let evidence: string
    try {
      evidence = readFileSync(claim.evidencePath, 'utf8')
    } catch {
      missing.push(
        `README claims ${claim.label}, but evidence file is missing: ${claim.evidencePath}`
      )
      continue
    }

    if (!claim.evidenceCheck(evidence)) {
      missing.push(
        `README claims ${claim.label}, but evidence file does not expose expected implementation: ${claim.evidencePath}`
      )
    }
  }

  return missing
}

export function writeReadmeParityReport(missing: string[]): void {
  mkdirSync('ci/audit', { recursive: true })
  writeFileSync(
    join('ci/audit', 'readme-code-parity.json'),
    JSON.stringify(
      {
        implementedClaims: implementedClaims.map((claim) => claim.label),
        missing,
        status: missing.length ? 'FAIL' : 'PASS',
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

if (require.main === module) {
  const missing = checkImplementedClaims()
  writeReadmeParityReport(missing)
  if (missing.length > 0) {
    console.error(missing.join('\n'))
    process.exit(1)
  }
}
