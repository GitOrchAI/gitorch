import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractLatestPatchNote, sanitizeForSupermemory } from './sync-supermemory'

describe('Supermemory Sync Tests', () => {
  describe('DLP Sanitization', () => {
    it('throws error when identifying secrets', () => {
      const fakeTokenKey = 'sk-or-v1-' + '0'.repeat(64)
      expect(() => sanitizeForSupermemory(`Aqui está meu token: ${fakeTokenKey}`)).toThrow(/CRITICAL: Potential secret detected/)
    })

    it('removes internal markdown comments', () => {
      const content = `Público. <!-- INTERNAL START --> Privado <!-- INTERNAL END --> Público 2.`
      const sanitized = sanitizeForSupermemory(content)
      expect(sanitized).toBe('Público.  Público 2.')
    })
  })

  describe('Patch Note Extraction', () => {
    it('extracts classification, title and description from markdown changelog', () => {
      const mockChangelog = `# 📋 Latest Updates of GitOrch

This page is automatically updated...

### Recent Updates History

## Versão 1.0.1.0 - 2026-06-24 10:00:00
* **Author:** Guilherme (Commit: \`a1b2c3d\`)
* **Type:** Feature
* **Change:** New Supermemory Integration

We added a new script to automatically sync knowledge into the graph.

---

## Versão 1.0.0.0 - 2026-06-23
...
`
      const result = extractLatestPatchNote(mockChangelog)
      expect(result).not.toBeNull()
      expect(result?.classification).toBe('feature')
      expect(result?.title).toBe('New Supermemory Integration')
      expect(result?.description.includes('We added a new script')).toBe(true)
    })

    it('returns null if there are no version headers', () => {
      const result = extractLatestPatchNote('Just a plain text.')
      expect(result).toBeNull()
    })
  })
})
