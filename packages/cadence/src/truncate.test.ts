import { describe, it, expect } from 'vitest'
import { truncateDocument, processAttachmentsTokens } from './rails'

describe('Document Truncation', () => {
  it('truncates large document while preserving headers', () => {
    const text = `# Header 1\n\nSome normal paragraph that goes on and on and on and on and on and on.\n\n## Header 2\n\nAnother paragraph that is really long.\n\n\`\`\`javascript\nconst a = 1;\nconsole.log(a);\n\`\`\``
    const maxTokens = 25 // 100 characters. Marker is 53 chars. Remaining is 47.
    // "# Header 1" is 10 chars. "## Header 2" is 11 chars. Total 21 chars. Should fit both.
    const result = truncateDocument(text, maxTokens)

    expect(result).toContain('# Header 1')
    expect(result).toContain('## Header 2')
    expect(result).toContain('[Conteúdo truncado respeitando limites de contexto]')
    expect(result.length).toBeLessThan(text.length)
  })

  it('truncates document and handles missing global token budget', () => {
    const attachments = [
      { name: 'doc1.md', content: '# Doc 1\n\nContent 1' },
      {
        name: 'doc2.md',
        content: '# Doc 2\n\nContent 2 is a little bit longer and longer and longer.',
      },
      { name: 'doc3.md', content: '# Doc 3\n\nContent 3 should be truncated completely.' },
    ]

    const processed = processAttachmentsTokens(attachments, 2, 20)

    expect(processed[0].truncatedByTokens).toBe(true)
    expect(processed[1].truncatedByTokens).toBe(true)
    expect(processed[2].truncatedByTokens).toBe(true)
    expect(processed[2].content).toBe('[Conteúdo truncado respeitando limites de contexto]')
  })
})
