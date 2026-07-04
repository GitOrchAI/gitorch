import { describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { primeWorkspace } from './workspace-priming.js'

const execFileAsync = promisify(execFile)

async function initGitRepo(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-ws-'))
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: ws,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  await execFileAsync('git', ['-C', ws, 'init', '-q'], { env })
  await fs.writeFile(path.join(ws, 'AGENTS.md'), 'repo process — run shrimp/lint')
  await fs.writeFile(path.join(ws, 'README.md'), 'hello')
  await execFileAsync('git', ['-C', ws, 'add', '-A'], { env })
  await execFileAsync('git', ['-C', ws, 'commit', '-q', '-m', 'init'], { env })
  return ws
}

describe('primeWorkspace', () => {
  test('injeta instruções do GitOrch e sobrevive a git checkout/clean do motor', async () => {
    const ws = await initGitRepo()
    await primeWorkspace(ws)

    expect(await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf8')).toContain('GitOrch agent')
    expect(await fs.readFile(path.join(ws, 'AGENTS.md.gitorch-orig'), 'utf8')).toContain('shrimp')
    expect(await fs.readFile(path.join(ws, 'GEMINI.md'), 'utf8')).toContain('GitOrch agent')

    // simula o motor "resetando" o working tree
    const env = { PATH: process.env['PATH'] ?? '', HOME: ws }
    await execFileAsync('git', ['-C', ws, 'checkout', '--', '.'], { env })
    await execFileAsync('git', ['-C', ws, 'clean', '-fd'], { env })

    // priming sobrevive porque foi commitado
    expect(await fs.readFile(path.join(ws, 'AGENTS.md'), 'utf8')).toContain('GitOrch agent')
    expect(await fs.readFile(path.join(ws, 'GEMINI.md'), 'utf8')).toContain('GitOrch agent')

    await fs.rm(ws, { recursive: true, force: true })
  })

  test('idempotente: re-primar preserva o original verdadeiro', async () => {
    const ws = await initGitRepo()
    await primeWorkspace(ws)
    await primeWorkspace(ws)
    expect(await fs.readFile(path.join(ws, 'AGENTS.md.gitorch-orig'), 'utf8')).toContain('shrimp')
    await fs.rm(ws, { recursive: true, force: true })
  })

  test('funciona em diretório sem git (só escreve os arquivos)', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-nogit-'))
    await primeWorkspace(ws)
    expect(await fs.readFile(path.join(ws, 'GEMINI.md'), 'utf8')).toContain('GitOrch agent')
    await fs.rm(ws, { recursive: true, force: true })
  })
})
