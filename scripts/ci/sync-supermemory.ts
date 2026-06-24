import * as fs from 'node:fs'
import * as path from 'node:path'

interface WikiConfig {
  publicPaths: string[]
  renameMap: Record<string, string>
  supermemory?: {
    enabled: boolean
    containerTag: string
    apiUrl: string
  }
}

// Reutilizar a detecção de segredos do sync-wiki.ts
const SECRET_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/,
  /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,
  /sk-or-v1-[a-f0-9]{64}/,
  /sk-[a-zA-Z0-9]{32,}/,
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/,
  /aws_access_key_id\s*=\s*[A-Z0-9]{20}/i,
  /aws_secret_access_key\s*=\s*[a-zA-Z0-9/+=]{40}/i,
]

export function sanitizeForSupermemory(content: string): string {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(`CRITICAL: Potential secret detected during Supermemory sync`)
    }
  }
  let sanitized = content.replace(/<!--\s*INTERNAL START\s*-->[\s\S]*?<!--\s*INTERNAL END\s*-->/g, '')
  sanitized = sanitized.replace(/<!--\s*INTERNAL[\s\S]*?-->/g, '')
  return sanitized
}

export function extractLatestPatchNote(changelogContent: string): { title: string; description: string; classification: string } | null {
  // O changelog tem entradas no formato:
  // ## Versão 1.2.3.4 - YYYY-MM-DD HH:MM:SS
  // * **Author:** ...
  // * **Type:** Feature (ou Improvement, Patch / Fix)
  // * **Change:** Título curto
  //
  // Descrição detalhada...
  
  const entries = changelogContent.split('## Versão ')
  if (entries.length < 2) return null
  
  const latestEntry = entries[1] // índice 1 porque 0 é o cabeçalho
  const lines = latestEntry.split('\n')
  
  let classification = 'patch'
  let title = 'Code update'
  const descriptionLines: string[] = []
  
  let inDescription = false
  for (const line of lines) {
    if (line.includes('**Type:**')) {
      const typeVal = line.split('**Type:**')[1].trim().toLowerCase()
      if (typeVal.includes('feature')) classification = 'feature'
      else if (typeVal.includes('improvement')) classification = 'improvement'
    } else if (line.includes('**Change:**')) {
      title = line.split('**Change:**')[1].trim()
    } else if (line.startsWith('* **')) {
      continue
    } else if (line.trim() === '---') {
      break
    } else if (line.trim() !== '') {
      inDescription = true
      descriptionLines.push(line.trim())
    }
  }

  return {
    title,
    classification,
    description: descriptionLines.join(' '),
  }
}

async function sendMemoriesToSupermemory(apiUrl: string, apiKey: string, tag: string, memories: any[]) {
  const body = {
    containerTag: tag,
    memories: memories.map(m => ({
      content: sanitizeForSupermemory(m.content),
      isStatic: m.isStatic || false
    }))
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    // Timeout para não travar a esteira por muito tempo
    signal: AbortSignal.timeout(10000)
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`HTTP ${response.status}: ${errText}`)
  }
  
  return await response.json()
}

export async function runSupermemorySync() {
  const CONFIG_PATH = path.join(process.cwd(), 'wiki-config.json')
  const WIKI_TEMP_DIR = path.join(process.cwd(), 'wiki_temp')

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('wiki-config.json not found.')
    process.exit(0) // Não quebrar o pipeline por falta de config do supermemory
  }

  const config: WikiConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  const smConfig = config.supermemory

  if (!smConfig || !smConfig.enabled) {
    console.log('Supermemory sync is disabled in wiki-config.json')
    return
  }

  const apiKey = process.env.SUPERMEMORY_API_KEY
  if (!apiKey) {
    console.warn('SUPERMEMORY_API_KEY is not set. Skipping Supermemory sync.')
    return
  }

  console.log('Iniciando sincronização com Supermemory...')

  // 1. Obter a versão atual
  let currentVersion = 'unknown'
  const versionPath = path.join(WIKI_TEMP_DIR, 'version.json')
  if (fs.existsSync(versionPath)) {
    try {
      const v = JSON.parse(fs.readFileSync(versionPath, 'utf8'))
      currentVersion = v.version
    } catch {}
  }

  // 2. Extrair o patch note gerado da Wiki
  const changelogPath = path.join(WIKI_TEMP_DIR, 'Latest-Updates.md')
  let patchNoteMemory = null
  if (fs.existsSync(changelogPath)) {
    const changelogContent = fs.readFileSync(changelogPath, 'utf8')
    const extracted = extractLatestPatchNote(changelogContent)
    if (extracted) {
      const today = new Date().toISOString().split('T')[0]
      patchNoteMemory = {
        content: `[${smConfig.containerTag}] Version ${currentVersion} released on ${today}. Classification: ${extracted.classification}. Summary: "${extracted.title}". Details: ${extracted.description}`,
        isStatic: false
      }
    }
  }

  // 3. Montar resumo de wiki
  const filesList = fs.readdirSync(WIKI_TEMP_DIR).filter(f => f.endsWith('.md') || !f.includes('.'))
  const wikiMemory = {
    content: `[${smConfig.containerTag}] Wiki documentation was synced. Tracking ${filesList.length} documentation assets at version ${currentVersion}.`,
    isStatic: false
  }

  const memoriesToSend = [wikiMemory]
  if (patchNoteMemory) memoriesToSend.push(patchNoteMemory)

  // 4. Enviar para a API
  try {
    await sendMemoriesToSupermemory(smConfig.apiUrl, apiKey, smConfig.containerTag, memoriesToSend)
    console.log(`Enviadas ${memoriesToSend.length} memórias para o Supermemory (tag: ${smConfig.containerTag}).`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.warn(`Aviso: Falha ao sincronizar com Supermemory (não fatal): ${errMsg}`)
  }
}

if (require.main === module) {
  runSupermemorySync().catch(err => {
    console.error('Supermemory Sync Falhou (Não Fatal):', err)
  })
}
