export type {
  CortexDrawer,
  CortexIdentity,
  CortexLayer,
  CortexSearchResult,
  CortexTriple,
  CortexWakeUpResult,
} from './types'
export type { CortexClientOptions, EmbeddingFn } from './core/cortex-client'
export type { LayerSelectorOptions } from './core/layers'
export type {
  ChromaClientLike,
  ChromaCollectionLike,
  ChromaSemanticStoreOptions,
} from './db/chroma-store'
export type { SqliteStoreOptions, StoredTriple } from './db/sqlite-store'
export { CortexClient, deterministicEmbedding } from './core/cortex-client'
export { AakCodec } from './core/aak-codec'
export { LayerSelector } from './core/layers'
export { SqliteStore } from './db/sqlite-store'
export { ChromaSemanticStore } from './db/chroma-store'

export type { DocumentAttachment, SanitizedDocumentContent, SanitizationResult } from './types'

export function sanitizeAttachmentText(rawText: string): import('./types').SanitizationResult {
  const riskFlags: string[] = []

  // Normalize line breaks
  let cleanText = rawText.replace(/\r\n/g, '\n')

  // Remove control characters except tab and newline
  // [\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]
  const controlCharsRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g
  if (controlCharsRegex.test(cleanText)) {
    riskFlags.push('control_characters_detected')
    cleanText = cleanText.replace(controlCharsRegex, '')
  }

  // Detect and remove prompt injection patterns
  const patterns = [
    { regex: /SYSTEM PROMPT OVERRIDE/i, flag: 'system_prompt_override' },
    { regex: /ignore previous instructions/i, flag: 'ignore_previous_instructions' },
    { regex: /you are now a/i, flag: 'roleplay_override' },
    { regex: /<\|[a-zA-Z0-9_]+\|>/, flag: 'llm_control_sequence' },
  ]

  for (const { regex, flag } of patterns) {
    if (regex.test(cleanText)) {
      riskFlags.push(flag)
      cleanText = cleanText.replace(new RegExp(regex, 'gi'), '[REDACTED]')
    }
  }

  return {
    content: {
      cleanText,
      riskFlags,
    },
  }
}
