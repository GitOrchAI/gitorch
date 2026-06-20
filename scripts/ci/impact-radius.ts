import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type PackageRef = {
  name: string
  path: string
}

export function impactedPackages(changedFiles: string[]): string[] {
  const packages = discoverPackages()
  if (changedFiles.length === 0) {
    return packages.map((pkg) => pkg.name).sort()
  }

  const impacted = new Set<string>()

  for (const file of changedFiles) {
    if (isRootOrSharedChange(file)) {
      return packages.map((pkg) => pkg.name).sort()
    }

    const pkg = packages.find(
      (candidate) => file === candidate.path || file.startsWith(`${candidate.path}/`)
    )
    if (pkg) {
      impacted.add(pkg.name)
    }
  }

  return [...impacted].sort()
}

export function writeImpactRadiusReport(changedFiles: string[]): void {
  const packages = impactedPackages(changedFiles)
  const output = {
    changedFiles,
    packages,
    timestamp: new Date().toISOString(),
  }
  mkdirSync('ci/audit', { recursive: true })
  writeFileSync('ci/audit/impact-radius.json', JSON.stringify(output, null, 2))
  console.log(JSON.stringify(output, null, 2))
}

function discoverPackages(): PackageRef[] {
  const packageDirs = ['packages', 'apps', 'runtime', 'db']
  const packages: PackageRef[] = []

  for (const dir of packageDirs) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const packageJsonPath = join(dir, entry.name, 'package.json')
      try {
        const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string }
        if (manifest.name) {
          packages.push({ name: manifest.name, path: join(dir, entry.name) })
        }
      } catch {
        // Ignore directories that are not npm packages.
      }
    }
  }

  return packages
}

function isRootOrSharedChange(file: string): boolean {
  return (
    !file.startsWith('packages/') &&
    !file.startsWith('apps/') &&
    !file.startsWith('runtime/') &&
    file !== 'db/package.json' &&
    !file.startsWith('db/')
  )
}

if (require.main === module) {
  const changed = process.argv
    .slice(2)
    .flatMap((arg) => arg.split(/\s+/))
    .filter(Boolean)
  writeImpactRadiusReport(changed)
}
