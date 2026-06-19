import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TreeSitterManager } from '../parser/tree-sitter-manager'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('TreeSitterManager', () => {
  let manager: TreeSitterManager

  beforeAll(() => {
    manager = new TreeSitterManager()
  })

  afterAll(() => {
    // No explicit cleanup needed
  })

  it('should initialize with all language parsers', () => {
    expect(manager.getParser('typescript')).toBeDefined()
    expect(manager.getParser('tsx')).toBeDefined()
    expect(manager.getParser('python')).toBeDefined()
    expect(manager.getParser('go')).toBeDefined()
    expect(manager.getParser('rust')).toBeDefined()
  })

  it('should parse TypeScript code', () => {
    const code = `function hello(name: string): string {
  return \`Hello, \${name}!\`
}`
    const tree = manager.parseString(code, 'typescript')
    expect(tree).toBeDefined()
    expect(tree!.rootNode.type).toBe('program')
  })

  it('should parse TSX code', () => {
    const code = `const Component = () => <div>Hello</div>`
    const tree = manager.parseString(code, 'tsx')
    expect(tree).toBeDefined()
    expect(tree!.rootNode.type).toBe('program')
  })

  it('should parse Python code', () => {
    const code = `def hello(name: str) -> str:
    return f"Hello, {name}!"`
    const tree = manager.parseString(code, 'python')
    expect(tree).toBeDefined()
    expect(tree!.rootNode.type).toBe('module')
  })

  it('should parse Go code', () => {
    const code = `package main

func hello(name string) string {
    return "Hello, " + name + "!"
}`
    const tree = manager.parseString(code, 'go')
    expect(tree).toBeDefined()
    expect(tree!.rootNode.type).toBe('source_file')
  })

  it('should parse Rust code', () => {
    const code = `fn hello(name: &str) -> String {
    format!("Hello, {}!", name)
}`
    const tree = manager.parseString(code, 'rust')
    expect(tree).toBeDefined()
    expect(tree!.rootNode.type).toBe('source_file')
  })

  it('should return null for unknown language', () => {
    const tree = manager.parseString('code', 'unknown-lang')
    expect(tree).toBeNull()
  })

  it('should parse file by extension', () => {
    const tmpDir = os.tmpdir()
    const testFile = path.join(tmpDir, 'test-parse.ts')

    fs.writeFileSync(testFile, 'const x = 42')

    const tree = manager.parseFile(testFile)
    expect(tree).toBeDefined()
    expect(tree!.rootNode.type).toBe('program')

    fs.unlinkSync(testFile)
  })

  it('should return null for unsupported file extension', () => {
    const tree = manager.parseFile('/path/to/file.xyz')
    expect(tree).toBeNull()
  })
})
