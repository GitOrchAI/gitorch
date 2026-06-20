import { execFileSync } from 'node:child_process'

execFileSync('pnpm', ['exec', 'playwright', 'test'], { stdio: 'inherit' })
