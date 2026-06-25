import * as fs from 'node:fs'
import * as path from 'node:path'

interface WikiConfig {
  publicPaths: string[]
  renameMap: Record<string, string>
}

const CONFIG_PATH = path.join(process.cwd(), 'wiki-config.json')
const WIKI_TEMP_DIR = path.join(process.cwd(), 'wiki_temp')

// Regexes for sensitive data detection (DLP)
const SECRET_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/, // GitHub personal access token (classic)
  /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/, // GitHub fine-grained PAT
  /sk-or-v1-[a-f0-9]{64}/, // OpenRouter API key
  /sk-[a-zA-Z0-9]{32,}/, // Generic OpenAI/other API keys
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/, // SSH/RSA Private keys
  /aws_access_key_id\s*=\s*[A-Z0-9]{20}/i, // AWS Access Key
  /aws_secret_access_key\s*=\s*[a-zA-Z0-9/+=]{40}/i, // AWS Secret Key
]

export function sanitizeContent(content: string, filepath: string): string {
  // 1. Check for leaked secrets
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `CRITICAL: Potential secret detected in ${filepath} matching pattern ${pattern.toString()}`
      )
    }
  }

  // 2. Remove multiline internal blocks: <!-- INTERNAL START --> ... <!-- INTERNAL END -->
  let sanitized = content.replace(
    /<!--\s*INTERNAL START\s*-->[\s\S]*?<!--\s*INTERNAL END\s*-->/g,
    ''
  )

  // 3. Remove inline internal comments: <!-- INTERNAL: ... --> or <!-- INTERNAL ... -->
  sanitized = sanitized.replace(/<!--\s*INTERNAL[\s\S]*?-->/g, '')

  return sanitized
}

export function rewriteLinks(
  content: string,
  filePath: string,
  allPublicFiles: Set<string>,
  renameMap: Record<string, string>,
  repoFullName: string = 'loureng/gitorch'
): string {
  const fileDir = path.dirname(filePath)

  // Match markdown links: [text](url)
  // Negative lookahead to avoid matching absolute URLs (http, https, mailto) or anchors
  return content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    // If it's an external link or anchor link, leave it as is
    if (/^(https?|mailto|ftp):/i.test(url) || url.startsWith('#')) {
      return match
    }

    // Split path and hash/query (e.g. docs/setup.md#installation -> docs/setup.md and #installation)
    const urlParts = url.split('#')
    const relativePath = urlParts[0]
    const hash = urlParts[1] ? `#${urlParts[1]}` : ''

    if (!relativePath) {
      return match // just an anchor link like [](#section)
    }

    // Resolve the absolute path of the target file
    const absoluteTarget = path.resolve(fileDir, decodeURIComponent(relativePath))
    const relativeFromRoot = path.relative(process.cwd(), absoluteTarget).replace(/\\/g, '/')

    // Check if the target file is in the public whitelist
    if (allPublicFiles.has(absoluteTarget)) {
      // Find the wiki page name
      const basename = path.basename(absoluteTarget)
      let wikiPageName = ''

      if (renameMap[relativeFromRoot]) {
        wikiPageName = path.basename(renameMap[relativeFromRoot], '.md')
      } else {
        wikiPageName = basename.replace(/\.md$/i, '').replace(/\s+/g, '-')
      }

      return `[${text}](${wikiPageName}${hash})`
    } else {
      // If the target file is not in the whitelist (e.g. source code or internal docs),
      // rewrite it to point directly to the main repository on GitHub
      const repoUrl = `https://github.com/${repoFullName}/blob/main/${relativeFromRoot}`
      return `[${text}](${repoUrl}${hash})`
    }
  })
}

// Helper to recursively list markdown files in a directory
function getMdFiles(dir: string): string[] {
  let results: string[] = []
  if (!fs.existsSync(dir)) return results
  const list = fs.readdirSync(dir)
  for (const file of list) {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat && stat.isDirectory()) {
      results = results.concat(getMdFiles(filePath))
    } else if (file.endsWith('.md')) {
      results.push(filePath)
    }
  }
  return results
}

export function runSync() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config file not found at ${CONFIG_PATH}`)
    process.exit(1)
  }

  const config: WikiConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  const repoFullName = process.env.GITHUB_REPOSITORY || 'loureng/gitorch'

  // 1. Gather all files to sync
  const allPublicFiles = new Set<string>()
  const filePairs: { source: string; targetName: string }[] = []

  for (const publicPath of config.publicPaths) {
    const absolutePath = path.resolve(process.cwd(), publicPath)
    if (!fs.existsSync(absolutePath)) {
      console.warn(`Warning: Whitelisted path does not exist: ${publicPath}`)
      continue
    }

    const stat = fs.statSync(absolutePath)
    if (stat.isDirectory()) {
      const files = getMdFiles(absolutePath)
      for (const file of files) {
        allPublicFiles.add(file)
        // Default target name for nested files: replace space with hyphen and flatten to root
        const relativeToDir = path.relative(absolutePath, file)
        const name = relativeToDir.replace(/[\/\\]/g, '-').replace(/\s+/g, '-')
        filePairs.push({ source: file, targetName: name })
      }
    } else if (stat.isFile() && publicPath.endsWith('.md')) {
      allPublicFiles.add(absolutePath)
      const relativeFromRoot = path.relative(process.cwd(), absolutePath).replace(/\\/g, '/')
      const targetName = config.renameMap[relativeFromRoot] || path.basename(absolutePath)
      filePairs.push({ source: absolutePath, targetName })
    }
  }

  // Ensure wiki_temp exists
  if (!fs.existsSync(WIKI_TEMP_DIR)) {
    fs.mkdirSync(WIKI_TEMP_DIR, { recursive: true })
  }

  console.log(`Syncing ${filePairs.length} files to Wiki...`)

  // 2. Process and write each file
  for (const pair of filePairs) {
    let content = fs.readFileSync(pair.source, 'utf-8')

    // Apply sanitization (DLP)
    content = sanitizeContent(content, pair.source)

    // Rewrite relative links
    content = rewriteLinks(content, pair.source, allPublicFiles, config.renameMap, repoFullName)

    // Specific formatting: Append Patch Notes links to Home pages (README equivalents)
    const targetBaseName = path.basename(pair.targetName, '.md')
    if (targetBaseName === 'Home') {
      content += '\n\n---\n📢 _[Latest Updates](Latest-Updates)_\n'
    } else if (targetBaseName === 'Home-PT-BR') {
      content += '\n\n---\n📢 _[Últimas Atualizações](Ultimas-Atualizacoes)_\n'
    } else if (targetBaseName === 'Home-ES') {
      content += '\n\n---\n📢 _[Últimas Actualizaciones](Ultimas-Actualizaciones)_\n'
    }

    const targetPath = path.join(WIKI_TEMP_DIR, pair.targetName)
    fs.writeFileSync(targetPath, content, 'utf-8')
    console.log(
      `Synced: ${path.relative(process.cwd(), pair.source)} -> wiki_temp/${pair.targetName}`
    )
  }

  console.log('Wiki sync completed successfully!')
}

// Run the script if executed directly
if (require.main === module) {
  try {
    runSync()
  } catch (error) {
    console.error('Wiki Sync Failed:', error)
    process.exit(1)
  }
}
