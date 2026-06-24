import { execSync } from 'node:child_process'

const packages = ['packages/cgc', 'packages/cortex']

for (const pkg of packages) {
  console.log(`Typechecking ${pkg}...`)
  execSync(`pnpm exec tsc --noEmit --strict true -p ${pkg}/tsconfig.json`, {
    stdio: 'inherit',
  })
}
