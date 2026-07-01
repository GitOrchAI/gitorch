import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Detecta chaves de mapeamento duplicadas num YAML de workflow (ex.: dois `GH_TOKEN:` no
 * mesmo bloco `env:`). GitHub Actions rejeita isso em tempo de execução (startup_failure,
 * 0 jobs), mas parsers YAML tolerantes (js-yaml/PyYAML com load/safe_load) aceitam
 * silenciosamente, mantendo só a última ocorrência — por isso esse bug passa despercebido
 * em validação YAML comum (aconteceu de verdade em jules-pr-conflict.yml).
 *
 * Estratégia: rastreia blocos de mapeamento por nível de indentação (sem depender de um
 * parser YAML completo). Pula corretamente o corpo de scalars de bloco (`chave: |` / `>`),
 * onde texto livre (ex.: scripts bash em `run: |`) não deve ser interpretado como chaves.
 */
export function findDuplicateKeys(source: string): Array<{ line: number; key: string }> {
  const lines = source.split('\n')
  const duplicates: Array<{ line: number; key: string }> = []
  const stack: Array<{ indent: number; keys: Set<string> }> = []
  let skipBlockScalarIndent: number | null = null

  // Item de sequencia ("- name: x", ou "- foo") sempre inicia um mapeamento NOVO — cada
  // "- " é um elemento distinto de uma lista (ex.: cada step em `steps:`), nao uma chave
  // repetida dentro do mesmo mapa.
  const dashKeyRe = /^(\s*)-\s+([A-Za-z0-9_.-]+):(\s|$)/
  const plainKeyRe = /^(\s*)([A-Za-z0-9_.-]+):(\s|$)/
  const blockScalarRe = /:\s*[|>][+-]?\s*(#.*)?$/

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue

    const indent = raw.match(/^(\s*)/)?.[1]?.length ?? 0

    if (skipBlockScalarIndent !== null) {
      if (indent > skipBlockScalarIndent) continue
      skipBlockScalarIndent = null
    }

    const dashMatch = raw.match(dashKeyRe)
    if (dashMatch) {
      const key = dashMatch[2]
      if (!key) continue
      const contentIndent = raw.indexOf(key, dashMatch[1]!.length)
      // Novo item de lista: descarta qualquer mapeamento (do item anterior) neste nivel ou mais fundo.
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= contentIndent) stack.pop()
      stack.push({ indent: contentIndent, keys: new Set([key]) })
      if (blockScalarRe.test(raw)) skipBlockScalarIndent = contentIndent
      continue
    }

    const m = raw.match(plainKeyRe)
    if (!m) continue
    const key = m[2]
    if (!key) continue

    while (stack.length > 0 && stack[stack.length - 1]!.indent > indent) stack.pop()

    const top = stack[stack.length - 1]
    if (top && top.indent === indent) {
      if (top.keys.has(key)) {
        duplicates.push({ line: i + 1, key })
      } else {
        top.keys.add(key)
      }
    } else {
      stack.push({ indent, keys: new Set([key]) })
    }

    if (blockScalarRe.test(raw)) {
      skipBlockScalarIndent = indent
    }
  }

  return duplicates
}

export function validateWorkflowsDir(dir: string): string[] {
  const errors: string[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const path = join(dir, file)
    const content = readFileSync(path, 'utf8')
    const dups = findDuplicateKeys(content)
    if (dups.length > 0) {
      const details = dups.map((d) => `linha ${d.line}: '${d.key}'`).join(', ')
      errors.push(`${file}: chave(s) duplicada(s) — ${details}`)
    }
  }
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = validateWorkflowsDir('.github/workflows')
  if (errors.length > 0) {
    throw new Error(`Workflows com chaves YAML duplicadas:\n${errors.join('\n')}`)
  }
  console.log('Todos os workflows em .github/workflows/ estão sem chaves duplicadas.')
}
