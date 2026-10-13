//
// Extração de importações de um arquivo, compartilhada pela conferência de
// declarações (conferir-importacoes.mjs) e pela conferência de resolução do
// pacote da versão (conferir-resolucao-do-pacote.mjs).
import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')
const EMBUTIDOS = new Set(builtinModules)

/** `@escopo/nome/sub` -> `@escopo/nome`; `nome/sub` -> `nome`; o que não é pacote -> null. */
export function nomeDoPacote(especificador) {
  if (
    especificador === '' ||
    especificador.startsWith('.') ||
    especificador.startsWith('/') ||
    especificador.startsWith('#') ||
    especificador.startsWith('node:')
  ) {
    return null
  }
  const partes = especificador.split('/')
  const nome = especificador.startsWith('@') ? partes.slice(0, 2).join('/') : partes[0]
  if (!nome || EMBUTIDOS.has(nome)) return null
  return nome
}

/**
 * Devolve as importações de execução do arquivo:
 * `importacoes` = [{ especificador, linha }] com literal;
 * `dinamicas` = quantas `import(expr)`/`require(expr)` têm expressão e não dá para conferir.
 */
export function importacoesDe(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8')
  const fonte = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true)
  const achadas = []
  let dinamicas = 0
  const anota = (no, literal) => {
    if (literal && ts.isStringLiteralLike(literal)) {
      const { line } = fonte.getLineAndCharacterOfPosition(literal.getStart(fonte))
      achadas.push({ especificador: literal.text, linha: line + 1 })
    } else if (literal) {
      dinamicas += 1
    }
  }
  const soTipos = (clausula) => {
    if (!clausula) return false
    if (clausula.isTypeOnly) return true
    // `import { type A, type B } from 'x'` não deixa nada em tempo de execução.
    const nomeado = clausula.namedBindings
    return (
      !clausula.name &&
      nomeado !== undefined &&
      ts.isNamedImports(nomeado) &&
      nomeado.elements.length > 0 &&
      nomeado.elements.every((el) => el.isTypeOnly)
    )
  }
  const visita = (no) => {
    if (ts.isImportDeclaration(no)) {
      if (!soTipos(no.importClause)) anota(no, no.moduleSpecifier)
    } else if (ts.isExportDeclaration(no)) {
      if (!no.isTypeOnly && no.moduleSpecifier) anota(no, no.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(no)) {
      const ref = no.moduleReference
      if (!no.isTypeOnly && ts.isExternalModuleReference(ref)) anota(no, ref.expression)
    } else if (ts.isCallExpression(no)) {
      const alvo = no.expression
      const ehImport = alvo.kind === ts.SyntaxKind.ImportKeyword
      const ehRequire = ts.isIdentifier(alvo) && alvo.text === 'require'
      if ((ehImport || ehRequire) && no.arguments.length > 0) anota(no, no.arguments[0])
    }
    ts.forEachChild(no, visita)
  }
  visita(fonte)
  return { importacoes: achadas, dinamicas }
}
