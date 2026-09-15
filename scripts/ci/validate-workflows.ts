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

/** Um `uses:` de action externa que não está preso a um commit. */
export interface ActionSemPin {
  line: number
  uses: string
}

const USES_RE = /^\s*-?\s*uses:\s*(\S+)/
const SHA_DE_40 = /^[0-9a-f]{40}$/

/**
 * Action externa fixada por TAG em vez do SHA de 40 do commit.
 *
 * A convenção está escrita em `.github/actions/setup-pnpm/action.yml`: tag é
 * MUTÁVEL, e `pnpm/action-setup@v3` — que este repositório já usou — nem tag
 * era, era uma BRANCH. Conteúdo que muda sob os pés de quem depende dele, sem
 * aviso.
 *
 * Ela valia para o repositório inteiro e nunca teve portão: em 13/09/2026 todo
 * workflow pinava por SHA, menos `pages.yml`, que carregava seis tags
 * flutuantes — e era justamente o que estava quebrado.
 *
 * Action INTERNA (`./.github/actions/...`) fica de fora de propósito: é caminho
 * local, versionado pelo próprio commit do repositório. `docker://` idem.
 */
export function findActionsSemPin(source: string): ActionSemPin[] {
  const achados: ActionSemPin[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim().startsWith('#')) continue
    const usos = raw.match(USES_RE)?.[1]
    if (!usos) continue
    if (usos.startsWith('./') || usos.startsWith('docker://')) continue

    const ref = usos.split('@')[1]
    if (ref !== undefined && SHA_DE_40.test(ref)) continue
    achados.push({ line: i + 1, uses: usos })
  }

  return achados
}

/**
 * `pnpm/action-setup` carregando `version:` no `with:`.
 *
 * Este é o defeito exato que derrubou o `pages.yml` em todo run entre 11/09 e
 * 13/09/2026, sempre no passo 2, com a mensagem:
 *
 *   Error: Multiple versions of pnpm specified:
 *     - version 9 in the GitHub Action config with the key "version"
 *     - version pnpm@9.4.0 in the package.json with the key "packageManager"
 *
 * A action lê `packageManager` do package.json da raiz sozinha. Declarar a
 * versão de novo no workflow não é redundância inofensiva: com as duas
 * presentes ela ABORTA, e o job morre antes de instalar qualquer coisa.
 *
 * Dez commits tentaram consertar aquele arquivo mexendo em permissão, env e id
 * de job — passos que rodam DEPOIS de um passo que nunca rodou. Um portão aqui
 * responde na hora, em vez de custar mais uma rodada de tentativa e erro.
 */
export function findPnpmSetupComVersion(source: string): number[] {
  const achados: number[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const usos = raw.match(USES_RE)?.[1]
    if (!usos?.startsWith('pnpm/action-setup')) continue

    const indentDoPasso = raw.search(/\S/)
    // Varre só o corpo DESTE passo: para no próximo item de lista (ou em
    // qualquer linha que volte ao nível dele), para não acusar um `version:`
    // que pertence a outra action mais abaixo.
    for (let j = i + 1; j < lines.length; j++) {
      const corpo = lines[j] ?? ''
      if (corpo.trim() === '' || corpo.trim().startsWith('#')) continue
      const indent = corpo.search(/\S/)
      if (indent <= indentDoPasso) break
      if (/^\s*version:/.test(corpo)) {
        achados.push(j + 1)
        break
      }
    }
  }

  return achados
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

    const semPin = findActionsSemPin(content)
    if (semPin.length > 0) {
      const details = semPin.map((a) => `linha ${a.line}: '${a.uses}'`).join(', ')
      errors.push(
        `${file}: action externa sem pin de commit (use o SHA de 40 com a versão em comentário ao lado) — ${details}`
      )
    }

    const comVersion = findPnpmSetupComVersion(content)
    if (comVersion.length > 0) {
      const details = comVersion.map((l) => `linha ${l}`).join(', ')
      errors.push(
        `${file}: pnpm/action-setup com 'version:' — conflita com 'packageManager' do package.json e aborta o job (${details})`
      )
    }
  }
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = validateWorkflowsDir('.github/workflows')
  if (errors.length > 0) {
    throw new Error(`Workflows fora do portão:\n${errors.join('\n')}`)
  }
  console.log(
    'Todos os workflows em .github/workflows/: sem chave duplicada, com action externa presa a commit, e sem version: no pnpm/action-setup.'
  )
}
