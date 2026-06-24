import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const packages = ['packages/cgc', 'packages/cortex']
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

for (const pkg of packages) {
  execFileSync(
    process.execPath,
    [tsc, '--noEmit', '--strict', 'true', '-p', `${pkg}/tsconfig.json`],
    {
      stdio: 'inherit',
    }
  )
}
