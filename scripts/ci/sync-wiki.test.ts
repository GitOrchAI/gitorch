import { describe, it, expect } from 'vitest'
import { sanitizeContent, rewriteLinks } from './sync-wiki'
import * as path from 'node:path'

describe('sync-wiki DLP Sanitization', () => {
  it('should remove multiline internal blocks', () => {
    const raw = `
# Public Header
<!-- INTERNAL START -->
This is internal database configuration:
db_host: local
<!-- INTERNAL END -->
Public description.
`
    const clean = sanitizeContent(raw, 'test.md')
    expect(clean).toContain('# Public Header')
    expect(clean).toContain('Public description.')
    expect(clean).not.toContain('This is internal database configuration')
    expect(clean).not.toContain('db_host')
  })

  it('should remove inline internal comments', () => {
    const raw = `Public line <!-- INTERNAL: Remember to update this on release --> text.`
    const clean = sanitizeContent(raw, 'test.md')
    expect(clean).toBe('Public line  text.')
  })

  it('should throw an error if a GitHub token is leaked', () => {
    const leaked = `Here is our token: ghp_` + '1234567890abcdefghijklmnopqrstuvwxyz'
    expect(() => sanitizeContent(leaked, 'test.md')).toThrow('Potential secret detected')
  })

  it('should throw an error if an OpenRouter key is leaked', () => {
    const leaked = `key: sk-or-v1-` + '0'.repeat(64)
    expect(() => sanitizeContent(leaked, 'test.md')).toThrow('Potential secret detected')
  })

  it('should throw an error if AWS access key is leaked', () => {
    const leaked = `aws_access_key_id = ` + 'AKIAIOSFODNN7EXAMPLE'
    expect(() => sanitizeContent(leaked, 'test.md')).toThrow('Potential secret detected')
  })
})

describe('sync-wiki Link Rewriting', () => {
  const allPublic = new Set<string>([
    path.resolve(process.cwd(), 'README.md'),
    path.resolve(process.cwd(), 'docs/product/BRD.md'),
    path.resolve(process.cwd(), 'docs/setup/install.md'),
  ])

  const renameMap = {
    'README.md': 'Home.md',
  }

  it('should rewrite whitelisted links to be flat and extensionless', () => {
    const sourcePath = path.resolve(process.cwd(), 'docs/product/BRD.md')
    const content = `Read the [Install Guide](../setup/install.md) and [Readme](../../README.md) for more.`

    const rewritten = rewriteLinks(content, sourcePath, allPublic, renameMap)
    expect(rewritten).toBe('Read the [Install Guide](install) and [Readme](Home) for more.')
  })

  it('should preserve hashes on rewritten links', () => {
    const sourcePath = path.resolve(process.cwd(), 'docs/product/BRD.md')
    const content = `Read [Install Guide](../setup/install.md#step-1).`

    const rewritten = rewriteLinks(content, sourcePath, allPublic, renameMap)
    expect(rewritten).toBe('Read [Install Guide](install#step-1).')
  })

  it('should rewrite non-whitelisted relative links to the GitHub repository url', () => {
    const sourcePath = path.resolve(process.cwd(), 'docs/product/BRD.md')
    const content = `Check out the code in [index.ts](../../packages/index.ts).`

    const rewritten = rewriteLinks(content, sourcePath, allPublic, renameMap, 'loureng/gitorch')
    expect(rewritten).toBe(
      'Check out the code in [index.ts](https://github.com/loureng/gitorch/blob/main/packages/index.ts).'
    )
  })

  it('should not touch absolute URLs or anchor-only links', () => {
    const sourcePath = path.resolve(process.cwd(), 'docs/product/BRD.md')
    const content = `Go to [Google](https://google.com) or [Section](#section).`

    const rewritten = rewriteLinks(content, sourcePath, allPublic, renameMap)
    expect(rewritten).toBe('Go to [Google](https://google.com) or [Section](#section).')
  })
})
