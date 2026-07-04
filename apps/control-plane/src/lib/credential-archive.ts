import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Serializa/desserializa um diretório de credencial de motor (ex.: ~/.codex,
// ~/.gemini, ~/.claude) para um blob string transportável. Permite capturar a
// credencial de um login e guardá-la cifrada por usuário (EngineConnection),
// depois restaurá-la dentro do HOME isolado da missão — sem depender da
// credencial ambiente do host.

interface ArchivedEntry {
  path: string // relativo à raiz do diretório
  mode: number
  content: string // base64
}

interface ArchiveV1 {
  version: 1
  entries: ArchivedEntry[]
}

// Guarda contra pacotes gigantes (credencial é pequena; um dir enorme indica erro).
const MAX_TOTAL_BYTES = 32 * 1024 * 1024

async function walk(root: string, current: string, entries: ArchivedEntry[]): Promise<number> {
  let total = 0
  const dirents = await fs.readdir(current, { withFileTypes: true })
  for (const dirent of dirents) {
    const abs = path.join(current, dirent.name)
    if (dirent.isSymbolicLink()) continue // não seguimos symlinks (evita escapar da raiz)
    if (dirent.isDirectory()) {
      total += await walk(root, abs, entries)
      continue
    }
    if (!dirent.isFile()) continue
    const stat = await fs.stat(abs)
    total += stat.size
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`Diretório de credencial excede ${MAX_TOTAL_BYTES} bytes; recusando arquivar`)
    }
    const content = await fs.readFile(abs)
    entries.push({
      path: path.relative(root, abs),
      mode: stat.mode & 0o777,
      content: content.toString('base64'),
    })
  }
  return total
}

/** Empacota `dir` num blob string. Retorna null se o diretório não existe. */
export async function archiveDirectory(dir: string): Promise<string | null> {
  const exists = await fs
    .stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (!exists) return null

  const entries: ArchivedEntry[] = []
  await walk(dir, dir, entries)
  const archive: ArchiveV1 = { version: 1, entries }
  return JSON.stringify(archive)
}

/**
 * Empacota um conjunto específico de caminhos (arquivos ou diretórios) relativos
 * a `baseDir`. Diferente de archiveDirectory: captura SÓ o que interessa (os
 * arquivos de credencial), não a árvore inteira — os diretórios de motor têm
 * históricos/caches de gigabytes que não são credencial. Retorna null se nenhum
 * dos caminhos existir.
 */
export async function archivePaths(baseDir: string, relPaths: string[]): Promise<string | null> {
  const entries: ArchivedEntry[] = []
  for (const rel of relPaths) {
    const abs = path.join(baseDir, rel)
    // lstat (não stat): um symlink no caminho de credencial não deve ser seguido
    // — senão `.codex/auth.json -> /etc/shadow` selaria arquivo arbitrário do
    // host no blob. walk() já pula symlinks aninhados; aqui cobrimos o topo.
    const stat = await fs.lstat(abs).catch(() => null)
    if (!stat) continue
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await walk(baseDir, abs, entries)
    } else if (stat.isFile()) {
      const content = await fs.readFile(abs)
      entries.push({ path: rel, mode: stat.mode & 0o777, content: content.toString('base64') })
    }
  }
  if (entries.length === 0) return null
  const archive: ArchiveV1 = { version: 1, entries }
  return JSON.stringify(archive)
}

/**
 * Restaura um blob em `destDir`. Recusa qualquer entrada cujo caminho escape da
 * raiz (defesa contra path traversal em blob adulterado).
 */
export async function restoreDirectory(blob: string, destDir: string): Promise<void> {
  const archive = JSON.parse(blob) as ArchiveV1
  if (archive.version !== 1) {
    throw new Error(`Versão de arquivo de credencial não suportada: ${archive.version}`)
  }
  // Credencial descriptografada em disco: raiz 0700 (só o dono acessa) — em host
  // compartilhado, ninguém mais pode atravessar até os tokens.
  const rootResolved = path.resolve(destDir)
  await fs.mkdir(rootResolved, { recursive: true, mode: 0o700 })
  await fs.chmod(rootResolved, 0o700).catch(() => undefined)

  for (const entry of archive.entries) {
    const target = path.resolve(rootResolved, entry.path)
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      throw new Error(`Entrada de credencial fora da raiz recusada: ${entry.path}`)
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    // Arquivo de credencial nunca legível por outros (0600), independente do
    // modo capturado (que pode ter vindo 0644 do host).
    await fs.writeFile(target, Buffer.from(entry.content, 'base64'), { mode: 0o600 })
  }
}
