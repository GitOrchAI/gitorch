import { readFileSync } from 'node:fs'

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { packageManager?: string }

if (!ci.includes('runs-on: ubuntu-latest')) {
  throw new Error('CI must use ubuntu-latest GitHub-hosted runners')
}
if (ci.includes('runs-on: self-hosted')) {
  throw new Error('CI must not use self-hosted runners')
}
if (!ci.includes('pnpm install --frozen-lockfile')) {
  throw new Error('CI must install with pnpm --frozen-lockfile')
}
if (pkg.packageManager !== 'pnpm@9.4.0') {
  throw new Error('packageManager must remain pnpm@9.4.0')
}
