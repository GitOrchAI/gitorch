import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const playwright = require.resolve('@playwright/test/cli')

execFileSync(process.execPath, [playwright, 'test'], { stdio: 'inherit' })
