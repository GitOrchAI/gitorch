import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function run() {
  const { stdout } = await execFileAsync('git', ['--version'])
  console.log(stdout)
}

run().catch(console.error)
