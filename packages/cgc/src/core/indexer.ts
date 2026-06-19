import { KuzuClient } from '../db/kuzu-client'
import { TreeSitterManager } from '../parser/tree-sitter-manager'
import { CGCNode } from '../types'
import * as path from 'path'

export class CodeGraphIndexer {
  private client: KuzuClient
  private manager: TreeSitterManager

  constructor(client: KuzuClient, manager: TreeSitterManager) {
    this.client = client
    this.manager = manager
  }

  async initializeSchema(): Promise<void> {
    // KuzuDB doesn't support IF NOT EXISTS natively for tables.
    // We catch the "already exists" error to make it idempotent.
    try {
      await this.client.createNodeTable('File', { id: 'STRING', filePath: 'STRING' }, 'id')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists') && !msg.includes('Table File already exists')) {
        throw e
      }
    }

    try {
      await this.client.createNodeTable(
        'Symbol',
        {
          id: 'STRING',
          name: 'STRING',
          type: 'STRING',
          filePath: 'STRING',
          startLine: 'INT64',
          endLine: 'INT64',
          startCol: 'INT64',
          endCol: 'INT64',
        },
        'id'
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists') && !msg.includes('Table Symbol already exists')) {
        throw e
      }
    }

    try {
      await this.client.execute(
        'CREATE REL TABLE GROUP CONTAINS(FROM File TO Symbol, FROM Symbol TO Symbol)'
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists')) {
        throw e
      }
    }

    try {
      await this.client.createRelTable('CALLS', 'Symbol', 'Symbol')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists')) {
        throw e
      }
    }

    try {
      await this.client.createRelTable('IMPORTS', 'Symbol', 'Symbol')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists')) {
        throw e
      }
    }
  }

  private getSymbolType(nodeType: string): CGCNode['type'] | null {
    switch (nodeType) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_definition':
      case 'function_item':
        return 'function'
      case 'class_declaration':
      case 'class_definition':
      case 'struct_item':
        return 'class'
      case 'method_definition':
      case 'method_declaration':
        return 'method'
      case 'interface_declaration':
      case 'trait_item':
        return 'interface'
      case 'type_alias_declaration':
        return 'type'
      case 'variable_declarator':
        return 'variable'
      case 'import_specifier':
        return 'import'
      default:
        return null
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getSymbolName(node: any, content: string): string | null {
    const type = node.type
    if (
      type === 'function_declaration' ||
      type === 'class_declaration' ||
      type === 'interface_declaration' ||
      type === 'type_alias_declaration'
    ) {
      for (let i = 0; i < node.childCount(); i++) {
        const child = node.child(i)
        if (child && (child.type === 'identifier' || child.type === 'type_identifier')) {
          return content.slice(child.startByte(), child.endByte())
        }
      }
    } else if (type === 'method_definition') {
      for (let i = 0; i < node.childCount(); i++) {
        const child = node.child(i)
        if (child && (child.type === 'property_identifier' || child.type === 'identifier')) {
          return content.slice(child.startByte(), child.endByte())
        }
      }
    } else if (type === 'variable_declarator' || type === 'import_specifier') {
      for (let i = 0; i < node.childCount(); i++) {
        const child = node.child(i)
        if (child && child.type === 'identifier') {
          return content.slice(child.startByte(), child.endByte())
        }
      }
    }
    return null
  }

  async indexFile(filePath: string, content: string, language: string): Promise<void> {
    const tree = this.manager.parseString(content, language)
    if (!tree) {
      throw new Error(`Failed to parse file: ${filePath}`)
    }

    const fileId = `cgc://${filePath}`

    // 1. Cleardown existing nodes and relationships for idempotency
    try {
      const fetchSymbolsQuery = `MATCH (f:File {id: $fileId})-[:CONTAINS]->(s:Symbol) RETURN s.id AS id`
      const existingSymbols = await this.client.query(fetchSymbolsQuery, { parameters: { fileId } })

      for (const row of existingSymbols) {
        await this.client.execute(`MATCH (s:Symbol {id: $id}) DETACH DELETE s`, { id: row['id'] })
      }

      await this.client.execute(`MATCH (f:File {id: $fileId}) DETACH DELETE f`, { fileId })
    } catch (e) {
      // Ignore if nodes/tables don't exist
    }

    // 2. Re-create the File node
    await this.client.execute(`CREATE (f:File {id: $fileId, filePath: $filePath})`, {
      fileId,
      filePath,
    })

    const symbolsToInsert: Array<{
      id: string
      name: string
      type: string
      startLine: number
      endLine: number
      startCol: number
      endCol: number
      parentId: string | null
    }> = []

    const importsToInsert: Array<{
      localSymbolId: string
      sourceSymbolId: string
    }> = []

    const callsToInsert: Array<{
      callerId: string
      calleeName: string
    }> = []

    const traverse = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: any,
      parentSymbolId: string | null,
      scopeNames: string[],
      activeModuleName: string | null
    ) => {
      let currentParentId = parentSymbolId
      const currentScopeNames = [...scopeNames]
      let currentModuleName = activeModuleName

      // Extract module name from import statement
      if (node.type === 'import_statement') {
        for (let i = 0; i < node.childCount(); i++) {
          const child = node.child(i)
          if (child && child.type === 'string') {
            const rawText = content.slice(child.startByte(), child.endByte())
            currentModuleName = rawText.slice(1, -1) // remove quotes
            break
          }
        }
      }

      // Check if it's a relevant Symbol
      const symbolType = this.getSymbolType(node.type)
      if (symbolType) {
        const name = this.getSymbolName(node, content) || 'anonymous'
        const id = `cgc://${filePath}#${[...currentScopeNames, name].join('.')}`

        symbolsToInsert.push({
          id,
          name,
          type: symbolType,
          startLine: node.startPosition().row + 1,
          endLine: node.endPosition().row + 1,
          startCol: node.startPosition().column,
          endCol: node.endPosition().column,
          parentId: parentSymbolId,
        })

        // If it's an import symbol, store the dependency link
        if (symbolType === 'import' && currentModuleName) {
          let sourcePath = currentModuleName
          if (currentModuleName.startsWith('.')) {
            const dirname = path.dirname(filePath)
            const resolved = path.join(dirname, currentModuleName)
            sourcePath = resolved.replace(/\\/g, '/')
            if (
              !sourcePath.endsWith('.ts') &&
              !sourcePath.endsWith('.js') &&
              !sourcePath.endsWith('.tsx')
            ) {
              sourcePath += '.ts' // default extension
            }
          }
          importsToInsert.push({
            localSymbolId: id,
            sourceSymbolId: `cgc://${sourcePath}#${name}`,
          })
        }

        if (symbolType === 'function' || symbolType === 'method' || symbolType === 'class') {
          currentParentId = id
          currentScopeNames.push(name)
        }
      }

      // Detect function calls inside active function/method scope
      if (node.type === 'call_expression' && parentSymbolId) {
        const calleeNode = node.child(0)
        if (calleeNode && calleeNode.type === 'identifier') {
          const calleeName = content.slice(calleeNode.startByte(), calleeNode.endByte())
          callsToInsert.push({
            callerId: parentSymbolId,
            calleeName,
          })
        }
      }

      // Recursively traverse children
      for (let i = 0; i < node.childCount(); i++) {
        const child = node.child(i)
        if (child) {
          traverse(child, currentParentId, currentScopeNames, currentModuleName)
        }
      }
    }

    // Start AST traversal
    traverse(tree.rootNode, null, [], null)

    // 3. Insert Symbols and create CONTAINS relations
    for (const sym of symbolsToInsert) {
      await this.client.execute(
        `CREATE (s:Symbol {id: $id, name: $name, type: $type, filePath: $filePath, startLine: $startLine, endLine: $endLine, startCol: $startCol, endCol: $endCol})`,
        {
          id: sym.id,
          name: sym.name,
          type: sym.type,
          filePath,
          startLine: sym.startLine,
          endLine: sym.endLine,
          startCol: sym.startCol,
          endCol: sym.endCol,
        }
      )

      // File CONTAINS Symbol
      await this.client.execute(
        `MATCH (f:File {id: $fileId}), (s:Symbol {id: $symbolId}) CREATE (f)-[:CONTAINS]->(s)`,
        { fileId, symbolId: sym.id }
      )

      // Parent Symbol CONTAINS Child Symbol
      if (sym.parentId) {
        await this.client.execute(
          `MATCH (p:Symbol {id: $parentId}), (c:Symbol {id: $childId}) CREATE (p)-[:CONTAINS]->(c)`,
          { parentId: sym.parentId, childId: sym.id }
        )
      }
    }

    // 4. Create IMPORTS relationships
    for (const imp of importsToInsert) {
      // Create relation if both target and source symbol nodes are in the DB.
      // In Cypher, MATCH will only succeed if both nodes exist.
      await this.client.execute(
        `MATCH (local:Symbol {id: $localId}), (source:Symbol {id: $sourceId}) CREATE (local)-[:IMPORTS]->(source)`,
        { localId: imp.localSymbolId, sourceId: imp.sourceSymbolId }
      )
    }

    // 5. Create CALLS relationships
    for (const call of callsToInsert) {
      // To resolve callee:
      // A. Check if the callee name is a local symbol in the same file
      const localCalleeId = `cgc://${filePath}#${call.calleeName}`
      const localMatches = symbolsToInsert.filter((s) => s.id === localCalleeId)

      if (localMatches.length > 0) {
        await this.client.execute(
          `MATCH (caller:Symbol {id: $callerId}), (callee:Symbol {id: $calleeId}) CREATE (caller)-[:CALLS]->(callee)`,
          { callerId: call.callerId, calleeId: localCalleeId }
        )
      } else {
        // B. Check if it's imported (the calleeName is an import symbol in the same file)
        const importedId = `cgc://${filePath}#${call.calleeName}`
        const importMatches = symbolsToInsert.filter(
          (s) => s.id === importedId && s.type === 'import'
        )
        if (importMatches.length > 0) {
          const matchedImport = importsToInsert.find((i) => i.localSymbolId === importedId)
          if (matchedImport) {
            await this.client.execute(
              `MATCH (caller:Symbol {id: $callerId}), (source:Symbol {id: $sourceId}) CREATE (caller)-[:CALLS]->(source)`,
              { callerId: call.callerId, sourceId: matchedImport.sourceSymbolId }
            )
          }
        }
      }
    }
  }
}
