import { describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { primeWorkspace, generateMultiRepoManifest } from './workspace-priming.js'

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

  test('diagnosticMode limpa arquivos transitórios e ignorados', async () => {
    const ws = await initGitRepo()

    // Adiciona arquivo ignorado e untracked
    const ignoredDir = path.join(ws, 'node_modules')
    await fs.mkdir(ignoredDir)
    await fs.writeFile(path.join(ignoredDir, 'cache.txt'), 'cache')
    await fs.writeFile(path.join(ws, '.gitignore'), 'node_modules/\n')

    const env = {
      PATH: process.env['PATH'] ?? '',
      HOME: ws,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    }
    await execFileAsync('git', ['-C', ws, 'add', '.gitignore'], { env })
    await execFileAsync('git', ['-C', ws, 'commit', '-q', '-m', 'add gitignore'], { env })

    // Cria modificações no arquivo trackeado e novo arquivo untracked
    await fs.writeFile(path.join(ws, 'README.md'), 'modified')
    await fs.writeFile(path.join(ws, 'untracked.txt'), 'untracked')

    await primeWorkspace(ws, { diagnosticMode: true })

    // reset --hard deve voltar arquivo ao estado commitado
    expect(await fs.readFile(path.join(ws, 'README.md'), 'utf8')).toEqual('hello')

    // clean -xfd deve apagar untracked
    await expect(fs.stat(path.join(ws, 'untracked.txt'))).rejects.toThrow()

    // clean -xfd deve apagar node_modules (ignorado)
    await expect(fs.stat(ignoredDir)).rejects.toThrow()

    await fs.rm(ws, { recursive: true, force: true })
  })
})

describe('generateMultiRepoManifest', () => {
  test('gera manifesto correto com 4 submódulos e suas roles', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-multirepo-'))

    const repos = [
      { name: 'front', role: 'frontend', relativePath: 'repos/front' },
      { name: 'back', role: 'backend', relativePath: 'repos/back' },
      { name: 'db', role: 'database', relativePath: 'repos/db' },
      { name: 'tests', role: 'automation', relativePath: 'repos/tests' },
    ]

    for (const repo of repos) {
      await fs.mkdir(path.join(ws, repo.relativePath), { recursive: true })
    }

    // Adiciona alguns contratos
    await fs.writeFile(path.join(ws, 'repos/back/api.openapi.yml'), 'openapi: 3.0.0')
    await fs.writeFile(path.join(ws, 'repos/db/schema.prisma'), 'datasource db { }')

    // Adiciona um .env local no backend com uma variável existente
    await fs.writeFile(
      path.join(ws, 'repos/back/.env'),
      'EXISTING_VAR=123\nBACKEND_DIR=/should/not/overwrite'
    )

    await generateMultiRepoManifest(ws, repos)

    // Verifica o manifesto
    const manifestPath = path.join(ws, '.gitorch', 'workspace-manifest.json')
    const manifestRaw = await fs.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestRaw)

    expect(Object.keys(manifest.repos).length).toBe(4)
    expect(manifest.repos['front'].role).toBe('frontend')
    expect(manifest.repos['front'].path).toBe(path.join(ws, 'repos/front'))

    // Verifica indexação de contratos
    expect(manifest.contracts.length).toBe(2)
    expect(manifest.contracts).toContain(path.join(ws, 'repos/back/api.openapi.yml'))
    expect(manifest.contracts).toContain(path.join(ws, 'repos/db/schema.prisma'))

    // Verifica ambiente root
    const rootEnv = await fs.readFile(path.join(ws, '.env'), 'utf8')
    expect(rootEnv).toContain('FRONTEND_DIR=' + path.join(ws, 'repos/front'))
    expect(rootEnv).toContain('BACKEND_DIR=' + path.join(ws, 'repos/back'))

    // Verifica ambiente local e merge não destrutivo
    const backEnv = await fs.readFile(path.join(ws, 'repos/back/.env'), 'utf8')
    expect(backEnv).toContain('EXISTING_VAR=123')
    expect(backEnv).toContain('BACKEND_DIR=/should/not/overwrite')
    expect(backEnv).not.toContain('BACKEND_DIR=' + path.join(ws, 'repos/back'))
    expect(backEnv).toContain('FRONTEND_DIR=' + path.join(ws, 'repos/front')) // Merged safely

    await fs.rm(ws, { recursive: true, force: true })
  })
})
