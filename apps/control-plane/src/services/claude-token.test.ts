import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { readClaudeTokenFromHome, claudeApiHeaders } from './claude-token.js'

afterEach(() => {
  delete process.env['GITORCH_CLAUDE_OAUTH_TOKEN']
})

describe('readClaudeTokenFromHome', () => {
  it('lê o token de .gitorch/env/CLAUDE_CODE_OAUTH_TOKEN dentro do homeDir', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-claude-token-'))
    await fs.mkdir(path.join(home, '.gitorch', 'env'), { recursive: true })
    await fs.writeFile(
      path.join(home, '.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN'),
      'sk-ant-oat01-abc\n'
    )
    expect(await readClaudeTokenFromHome(home)).toBe('sk-ant-oat01-abc')
    await fs.rm(home, { recursive: true, force: true })
  })

  it('arquivo ausente -> null (nunca lança)', async () => {
    expect(await readClaudeTokenFromHome('/tmp/gitorch-home-inexistente-xyz')).toBeNull()
  })

  it('conteúdo vazio/só espaço -> null', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-claude-token-empty-'))
    await fs.mkdir(path.join(home, '.gitorch', 'env'), { recursive: true })
    await fs.writeFile(path.join(home, '.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN'), '   \n')
    expect(await readClaudeTokenFromHome(home)).toBeNull()
    await fs.rm(home, { recursive: true, force: true })
  })

  it('override por ambiente (GITORCH_CLAUDE_OAUTH_TOKEN) vence o arquivo — teste/staging', async () => {
    process.env['GITORCH_CLAUDE_OAUTH_TOKEN'] = 'sk-ant-oat01-override'
    expect(await readClaudeTokenFromHome('/tmp/gitorch-home-qualquer-xyz')).toBe(
      'sk-ant-oat01-override'
    )
  })

  it('override vazio na env é ignorado (cai no arquivo)', async () => {
    process.env['GITORCH_CLAUDE_OAUTH_TOKEN'] = ''
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-claude-token-fallback-'))
    await fs.mkdir(path.join(home, '.gitorch', 'env'), { recursive: true })
    await fs.writeFile(
      path.join(home, '.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN'),
      'sk-ant-oat01-do-arquivo'
    )
    expect(await readClaudeTokenFromHome(home)).toBe('sk-ant-oat01-do-arquivo')
    await fs.rm(home, { recursive: true, force: true })
  })
})

describe('claudeApiHeaders', () => {
  it('monta authorization Bearer + anthropic-beta + anthropic-version', () => {
    expect(claudeApiHeaders('sk-ant-oat01-fake')).toEqual({
      authorization: 'Bearer sk-ant-oat01-fake',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    })
  })
})
