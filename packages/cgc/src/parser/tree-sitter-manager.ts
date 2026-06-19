import {
  WasmParser,
  getParser,
  WasmTree,
  WasmNode,
} from '@kreuzberg/tree-sitter-language-pack-wasm'
import * as fs from 'fs'
import * as path from 'path'

export interface ParseResult {
  tree: CompatTree
  language: string
}

interface CompatNode {
  type: string
  kind(): string
  childCount(): number
  child(index: number): CompatNode | undefined
  namedChild(index: number): CompatNode | undefined
  namedChildCount(): number
  parent(): CompatNode | undefined
  startByte(): number
  endByte(): number
  startPosition(): { row: number; column: number }
  endPosition(): { row: number; column: number }
  text: string
}

interface CompatTree {
  rootNode: CompatNode
  walk(): unknown
}

function wrapNode(node: WasmNode): CompatNode {
  return {
    get type(): string {
      return node.kind()
    },
    kind: () => node.kind(),
    childCount: () => node.childCount(),
    child: (index: number) => {
      const child = node.child(index)
      return child ? wrapNode(child) : undefined
    },
    namedChild: (index: number) => {
      const child = node.namedChild(index)
      return child ? wrapNode(child) : undefined
    },
    namedChildCount: () => node.namedChildCount(),
    parent: () => {
      const parent = node.parent()
      return parent ? wrapNode(parent) : undefined
    },
    startByte: () => node.startByte(),
    endByte: () => node.endByte(),
    startPosition: () => {
      const pos = node.startPosition()
      return { row: pos.row, column: pos.column }
    },
    endPosition: () => {
      const pos = node.endPosition()
      return { row: pos.row, column: pos.column }
    },
    get text(): string {
      // This would require source text, skipping for now
      return ''
    },
  }
}

function wrapTree(tree: WasmTree): CompatTree {
  return {
    get rootNode(): CompatNode {
      return wrapNode(tree.rootNode())
    },
    walk: () => tree.walk(),
  }
}

export class TreeSitterManager {
  private parsers: Map<string, WasmParser> = new Map()
  private extensionMap: Map<string, string> = new Map()

  private readonly languageConfig = {
    typescript: { extensions: ['ts', 'js'], wasmName: 'typescript' },
    tsx: { extensions: ['tsx', 'jsx'], wasmName: 'tsx' },
    python: { extensions: ['py'], wasmName: 'python' },
    go: { extensions: ['go'], wasmName: 'go' },
    rust: { extensions: ['rs'], wasmName: 'rust' },
  }

  constructor() {
    this.buildExtensionMap()
  }

  private buildExtensionMap(): void {
    for (const [lang, config] of Object.entries(this.languageConfig)) {
      for (const ext of config.extensions) {
        this.extensionMap.set(ext.toLowerCase(), lang)
      }
    }
  }

  private getOrCreateParser(language: string): WasmParser {
    let parser = this.parsers.get(language)
    if (!parser) {
      const config = this.languageConfig[language as keyof typeof this.languageConfig]
      if (!config) throw new Error(`Unsupported language: ${language}`)

      parser = getParser(config.wasmName)
      this.parsers.set(language, parser)
    }
    return parser
  }

  parseString(code: string, language: string): CompatTree | null {
    const config = this.languageConfig[language as keyof typeof this.languageConfig]
    if (!config) return null

    try {
      const parser = this.getOrCreateParser(language)
      const tree = parser.parse(code)
      return tree ? wrapTree(tree) : null
    } catch (error) {
      console.warn(`Failed to parse ${language}:`, error)
      return null
    }
  }

  parseFile(filePath: string): CompatTree | null {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const language = this.extensionMap.get(ext)
    if (!language) return null

    try {
      const code = fs.readFileSync(filePath, 'utf-8')
      return this.parseString(code, language)
    } catch {
      return null
    }
  }

  getParser(language: string): WasmParser | undefined {
    const config = this.languageConfig[language as keyof typeof this.languageConfig]
    if (!config) return undefined
    return this.getOrCreateParser(language)
  }

  getSupportedLanguages(): string[] {
    return Object.keys(this.languageConfig)
  }

  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys())
  }
}
