import { execFileSync } from 'node:child_process'

const packages = ['packages/cgc', 'packages/cortex']

for (const pkg of packages) {
  execFileSync('npx', ['tsc', '--noEmit', '--strict', 'true', '-p', `${pkg}/tsconfig.json`], {
    stdio: 'inherit',
  })
}
