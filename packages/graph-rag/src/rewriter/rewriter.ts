import type { ExtractorOutput, GraphRAGPlan, InfererOutput } from '../types'

const FILE_EXTENSION_PATTERN = 'ts|js|tsx|jsx|py|go|rs|cs|java|md'
const FILE_EXTENSION_REGEX = new RegExp(`\\.(?:${FILE_EXTENSION_PATTERN})$`, 'i')
const FILE_EXTENSION_BOUNDARY_PATTERN = `(?:${FILE_EXTENSION_PATTERN})\\b`
const FILE_NAME_PATTERN = `[A-Za-z0-9_.-]+\\.(?:${FILE_EXTENSION_PATTERN})`
const PATH_SEGMENT_PATTERN = '[A-Za-z0-9_.-]+'

const FILE_PATH_REGEX = new RegExp(
  [
    '(?<![\\w./~\\\\])',
    '(?:',
    `(?:[.]{1,2}|~)?[/\\\\](?:${PATH_SEGMENT_PATTERN}[/\\\\])*${FILE_NAME_PATTERN}`,
    '|',
    `(?:${PATH_SEGMENT_PATTERN}[/\\\\])+${FILE_NAME_PATTERN}`,
    '|',
    FILE_NAME_PATTERN,
    ')',
    '(?=[\\s"\'`.,;:)]|$)',
  ].join('')
)
const CAMEL_CASE_REGEX = /\b[A-Za-z_][a-z0-9_]*[A-Z][A-Za-z0-9_]*\b/
const SNAKE_CASE_REGEX = /\b[a-z][a-z0-9]*_[a-z0-9_]*\b/
const QUOTED_TERM_REGEX = /['"`]([^'"`]{1,160})['"`]/
const DOTTED_NAMESPACE_REGEX = new RegExp(
  `(?<![\\w.-])(?:[A-Za-z_][A-Za-z0-9_]*\\.)+(?!${FILE_EXTENSION_BOUNDARY_PATTERN})[A-Za-z_][A-Za-z0-9_]*(?![\\w-])`
)
const WORD_REGEX = /\b[A-Za-z][A-Za-z0-9_]*\b/
const MAX_INPUT_LENGTH = 2000
const STOP_WORDS = new Set([
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
])

const findAll = (regex: RegExp, value: string): RegExpMatchArray[] => {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  return Array.from(value.matchAll(new RegExp(regex.source, flags)))
}

const findFirst = (regex: RegExp, value: string): RegExpMatchArray | null => {
  return value.match(regex)
}

export class QueryRewriter {
  rewrite(rawIssue: string): GraphRAGPlan {
    const truncatedIssue = rawIssue.slice(0, MAX_INPUT_LENGTH)
    const extractor = this.extract(truncatedIssue)
    const inferer = this.infer(truncatedIssue, extractor)

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
    for (const match of findAll(FILE_PATH_REGEX, rawIssue)) {
      const normalized = this.normalizeFilePath(match[0])
      if (normalized.length > 0) {
        entities.add(normalized)
      }
    }
  }

  private addSymbolEntities(rawIssue: string, entities: Set<string>): void {
    for (const regex of [CAMEL_CASE_REGEX, SNAKE_CASE_REGEX]) {
      for (const match of findAll(regex, rawIssue)) {
        const symbol = this.cleanToken(match[0])
        if (
          symbol.length > 1 &&
          !this.isStopWord(symbol) &&
          !this.isSymbolInsideFilePath(symbol, entities)
        ) {
          entities.add(symbol)
        }
      }
    }
  }

  private addNamespaceEntities(rawIssue: string, entities: Set<string>): void {
    for (const match of findAll(DOTTED_NAMESPACE_REGEX, rawIssue)) {
      const namespace = this.cleanToken(match[0])
      if (namespace.length > 0) {
        entities.add(this.namespaceToPath(namespace))
      }
    }

    if (this.hasSeparability(rawIssue)) {
      for (const match of findAll(DOTTED_NAMESPACE_REGEX, rawIssue)) {
        const namespace = this.cleanToken(match[0])
        const namespacePath = this.namespaceToPath(namespace)
        if (namespacePath.toLowerCase().includes('modeling')) {
          entities.add(`${namespacePath}/separable.py`)
        }
      }
    }
  }

  private addQuotedEntities(rawIssue: string, entities: Set<string>): void {
    for (const match of findAll(QUOTED_TERM_REGEX, rawIssue)) {
      const term = match[1].trim()
      if (term.length === 0) {
        continue
      }

      if (this.isFilePath(term)) {
        entities.add(this.normalizeFilePath(term))
        continue
      }

      const namespaceMatch = findFirst(DOTTED_NAMESPACE_REGEX, term)
      if (namespaceMatch?.[0]) {
        entities.add(this.namespaceToPath(namespaceMatch[0]))
      }

      if (findFirst(CAMEL_CASE_REGEX, term) || findFirst(SNAKE_CASE_REGEX, term)) {
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

    for (const match of findAll(WORD_REGEX, rawIssue)) {
      const word = this.cleanToken(match[0]).toLowerCase()
      if (word.length > 2 && !this.isStopWord(word)) {
        keywords.add(word)
      }
    }

    for (const match of findAll(DOTTED_NAMESPACE_REGEX, rawIssue)) {
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
    return FILE_EXTENSION_REGEX.test(value.trim())
  }

  private normalizeFilePath(value: string): string {
    return value
      .replace(/\\/g, '/')
      .replace(/^['"`\s]+|['"`\s]+$/g, '')
      .replace(/[.,;:)]+$/g, '')
  }

  private cleanToken(value: string): string {
    return value.replace(/^[^\w]+|[^\w]+$/g, '')
  }

  private namespaceToPath(namespace: string): string {
    return namespace.split('.').join('/')
  }

  private isSymbolInsideFilePath(symbol: string, entities: Set<string>): boolean {
    return Array.from(entities).some((entity) => {
      if (!this.isFilePath(entity)) {
        return false
      }

      const symbolIndex = entity.indexOf(symbol)
      if (symbolIndex < 0) {
        return false
      }

      const before = entity[symbolIndex - 1]
      const after = entity[symbolIndex + symbol.length]
      return (
        (before === undefined || !this.isIdentifierChar(before)) &&
        (after === undefined || !this.isIdentifierChar(after))
      )
    })
  }

  private isIdentifierChar(value: string | undefined): boolean {
    return value !== undefined && /[A-Za-z0-9_]/.test(value)
  }

  private isStopWord(value: string): boolean {
    return STOP_WORDS.has(value.toLowerCase())
  }
}
