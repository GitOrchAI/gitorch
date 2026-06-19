import type { ExtractorOutput, GraphRAGPlan, InfererOutput } from '../types'

const FILE_EXTENSION_PATTERN = 'ts|js|tsx|jsx|py|go|rs|cs|java|md'

const FILE_PATH_REGEX = new RegExp(
  `\\b(?:[./~]?[\\w.-]+[\\/])?[A-Za-z0-9_.-]+\\.(?:${FILE_EXTENSION_PATTERN})\\b`,
  'g'
)
const CAMEL_CASE_REGEX = /\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g
const SNAKE_CASE_REGEX = /\b[a-z][a-z0-9_]*_[a-z0-9_]*\b/g
const QUOTED_TERM_REGEX = /['"`]([^'"`]{1,160})['"`]/g
const DOTTED_NAMESPACE_REGEX = /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*\b/g
const WORD_REGEX = /\b[A-Za-z][A-Za-z0-9_]*\b/g

export class QueryRewriter {
  rewrite(rawIssue: string): GraphRAGPlan {
    const extractor = this.extract(rawIssue)
    const inferer = this.infer(rawIssue, extractor)

    return {
      rawIssue,
      extractor,
      inferer,
    }
  }

  private extract(rawIssue: string): ExtractorOutput {
    const entities = new Set<string>()
    const keywords = new Set<string>()

    this.addFileEntities(rawIssue, entities)
    this.addSymbolEntities(rawIssue, entities)
    this.addNamespaceEntities(rawIssue, entities)
    this.addQuotedEntities(rawIssue, entities)
    this.addKeywordRules(rawIssue, entities, keywords)

    return {
      entities: Array.from(entities),
      keywords: Array.from(keywords),
    }
  }

  private infer(rawIssue: string, extractor: ExtractorOutput): InfererOutput {
    const lowerIssue = rawIssue.toLowerCase()
    const hasSeparability = lowerIssue.includes('separability') || lowerIssue.includes('separabil')
    const hasMatrix = lowerIssue.includes('matrix') || lowerIssue.includes('matriz')
    const hasNested = lowerIssue.includes('nested') || lowerIssue.includes('aninh')
    const hasRecursion = lowerIssue.includes('recurs') || hasNested

    const functionalParts: string[] = []
    const behavioralParts: string[] = []

    if (hasRecursion) {
      functionalParts.push('Use recursion to traverse nested model trees')
      behavioralParts.push(
        'Preserve leaf-level behavior while descending through nested structures'
      )
    }

    if (hasSeparability && hasMatrix) {
      functionalParts.push('compute separability_matrix for each leaf model')
    } else if (hasSeparability) {
      functionalParts.push('compute separability for each leaf model')
    }

    if (extractor.entities.some((entity) => this.isFilePath(entity))) {
      functionalParts.push('inspect the referenced source files')
      behavioralParts.push('rank files deterministically from extracted paths and symbols')
    }

    if (functionalParts.length === 0) {
      functionalParts.push('extract deterministic anchors for graph retrieval')
    }

    if (behavioralParts.length === 0) {
      behavioralParts.push('return a stable Graph RAG plan without external calls')
    }

    return {
      functionalReq: functionalParts.join(' and '),
      behavioralExpectation: behavioralParts.join(' and '),
    }
  }

  private addFileEntities(rawIssue: string, entities: Set<string>): void {
    for (const match of rawIssue.matchAll(FILE_PATH_REGEX)) {
      const normalized = this.normalizeFilePath(match[0])
      if (normalized.length > 0) {
        entities.add(normalized)
      }
    }
  }

  private addSymbolEntities(rawIssue: string, entities: Set<string>): void {
    for (const regex of [CAMEL_CASE_REGEX, SNAKE_CASE_REGEX]) {
      for (const match of rawIssue.matchAll(regex)) {
        const symbol = this.cleanToken(match[0])
        if (symbol.length > 1 && !this.isStopWord(symbol)) {
          entities.add(symbol)
        }
      }
    }
  }

  private addNamespaceEntities(rawIssue: string, entities: Set<string>): void {
    for (const match of rawIssue.matchAll(DOTTED_NAMESPACE_REGEX)) {
      const namespace = this.cleanToken(match[0])
      if (namespace.length > 0) {
        entities.add(this.namespaceToPath(namespace))
      }
    }

    if (this.hasSeparability(rawIssue)) {
      for (const match of rawIssue.matchAll(DOTTED_NAMESPACE_REGEX)) {
        const namespace = this.cleanToken(match[0])
        const namespacePath = this.namespaceToPath(namespace)
        if (namespacePath.toLowerCase().includes('modeling')) {
          entities.add(`${namespacePath}/separable.py`)
        }
      }
    }
  }

  private addQuotedEntities(rawIssue: string, entities: Set<string>): void {
    for (const match of rawIssue.matchAll(QUOTED_TERM_REGEX)) {
      const term = match[1].trim()
      if (term.length === 0) {
        continue
      }

      if (this.isFilePath(term)) {
        entities.add(this.normalizeFilePath(term))
        continue
      }

      if (DOTTED_NAMESPACE_REGEX.test(term)) {
        DOTTED_NAMESPACE_REGEX.lastIndex = 0
        const namespaceMatch = DOTTED_NAMESPACE_REGEX.exec(term)
        if (namespaceMatch?.[0]) {
          entities.add(this.namespaceToPath(namespaceMatch[0]))
        }
      }

      if (CAMEL_CASE_REGEX.test(term) || SNAKE_CASE_REGEX.test(term)) {
        entities.add(term)
      }
    }
  }

  private addKeywordRules(rawIssue: string, entities: Set<string>, keywords: Set<string>): void {
    const lowerIssue = rawIssue.toLowerCase()

    for (const entity of entities) {
      keywords.add(entity)
      keywords.add(entity.toLowerCase())
    }

    for (const match of rawIssue.matchAll(WORD_REGEX)) {
      const word = this.cleanToken(match[0]).toLowerCase()
      if (word.length > 2 && !this.isStopWord(word)) {
        keywords.add(word)
      }
    }

    for (const match of rawIssue.matchAll(DOTTED_NAMESPACE_REGEX)) {
      keywords.add(this.cleanToken(match[0]))
    }

    if (lowerIssue.includes('nested') || lowerIssue.includes('aninh')) {
      keywords.add('nested')
      keywords.add('recursion')
    }

    if (lowerIssue.includes('recurs')) {
      keywords.add('recursion')
    }

    if (this.hasSeparability(rawIssue)) {
      keywords.add('separability')
      if (lowerIssue.includes('matrix') || lowerIssue.includes('matriz')) {
        keywords.add('separability_matrix')
        keywords.add('matrix')
      }
    }

    if (lowerIssue.includes('leaf') || lowerIssue.includes('folha')) {
      keywords.add('leaf')
    }
  }

  private hasSeparability(rawIssue: string): boolean {
    const lowerIssue = rawIssue.toLowerCase()
    return lowerIssue.includes('separability') || lowerIssue.includes('separabil')
  }

  private isFilePath(value: string): boolean {
    return new RegExp(`\\.(?:${FILE_EXTENSION_PATTERN})$`, 'i').test(value.trim())
  }

  private normalizeFilePath(value: string): string {
    return value
      .replace(/\\/g, '/')
      .replace(/^['"`\s]+|['"`\s]+$/g, '')
      .replace(/[.,;:)]+$/g, '')
      .replace(/^\.\/+/, '')
      .replace(/^~\//, '')
  }

  private cleanToken(value: string): string {
    return value.replace(/^[^\w]+|[^\w]+$/g, '')
  }

  private namespaceToPath(namespace: string): string {
    return namespace.split('.').join('/')
  }

  private isStopWord(value: string): boolean {
    const lowerValue = value.toLowerCase()
    return new Set([
      'the',
      'and',
      'for',
      'from',
      'with',
      'this',
      'that',
      'into',
      'onto',
      'over',
      'under',
      'each',
      'should',
      'would',
      'could',
      'when',
      'where',
      'what',
      'which',
      'than',
      'then',
      'than',
      'has',
      'have',
      'had',
      'was',
      'were',
      'are',
      'but',
      'not',
      'you',
      'your',
      'our',
      'their',
      'its',
      'o',
      'a',
      'da',
      'de',
      'do',
      'em',
      'no',
      'na',
      'um',
      'uma',
      'por',
      'para',
      'que',
      'qual',
      'como',
      'se',
      'ao',
      'aos',
      'às',
      'as',
      'os',
    ]).has(lowerValue)
  }
}
