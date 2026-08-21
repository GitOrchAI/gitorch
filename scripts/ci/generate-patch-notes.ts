import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Configurações de idiomas
interface LanguageConfig {
  code: string
  name: string
  file: string
  header: string
  desc: string
  typeLabel: {
    feature: string
    improvement: string
    patch: string
  }
  authorLabel: string
  typeLabelText: string
  changeLabelText: string
  historyHeader: string
}

const LANGUAGES: LanguageConfig[] = [
  {
    code: 'pt-br',
    name: 'Português',
    file: 'Ultimas-Atualizacoes.md',
    header: '# 📋 Últimas Atualizações do GitOrch',
    desc: 'Esta página é atualizada automaticamente a cada alteração no repositório de código fonte principal. Ela permite que a comunidade acompanhe o progresso e desenvolvimento em tempo real.',
    typeLabel: {
      feature: 'Funcionalidade',
      improvement: 'Melhoria',
      patch: 'Correção / Ajuste',
    },
    authorLabel: 'Autor',
    typeLabelText: 'Tipo',
    changeLabelText: 'Alteração',
    historyHeader: '### Histórico de Atualizações Recentes',
  },
  {
    code: 'en',
    name: 'English',
    file: 'Latest-Updates.md',
    header: '# 📋 Latest Updates of GitOrch',
    desc: 'This page is automatically updated with every change in the main source code repository. It allows the community to track progress and development in real time.',
    typeLabel: {
      feature: 'Feature',
      improvement: 'Improvement',
      patch: 'Patch / Fix',
    },
    authorLabel: 'Author',
    typeLabelText: 'Type',
    changeLabelText: 'Change',
    historyHeader: '### Recent Updates History',
  },
  {
    code: 'es',
    name: 'Español',
    file: 'Ultimas-Actualizaciones.md',
    header: '# 📋 Últimas Actualizaciones de GitOrch',
    desc: 'Esta página se actualiza automáticamente con cada cambio en el repositorio principal de código fuente. Permite a la comunidad seguir el progreso y el desarrollo en tiempo real.',
    typeLabel: {
      feature: 'Funcionalidad',
      improvement: 'Mejora',
      patch: 'Corrección / Ajuste',
    },
    authorLabel: 'Autor',
    typeLabelText: 'Tipo',
    changeLabelText: 'Cambio',
    historyHeader: '### Historial de Actualizaciones Recientes',
  },
]

// Modelos gratuitos recomendados no OpenRouter
const FREE_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-2-9b-it:free',
]

interface VersionInfo {
  version: string
  lastUpdated: string
}

interface AIResponse {
  classification: 'feature' | 'improvement' | 'patch'
  pt: {
    title: string
    description: string
  }
  en: {
    title: string
    description: string
  }
  es: {
    title: string
    description: string
  }
}

// 1. Funções de auxílio para Execução do Git
function runGitCommand(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch (error) {
    console.error(`Erro ao executar comando git: ${cmd}`, error)
    return ''
  }
}

// 2. Heurística determinista para fallback de classificação
export function classifyChangesHeuristically(
  commitMsg: string,
  changedFiles: string[]
): 'feature' | 'improvement' | 'patch' {
  const msgLower = commitMsg.toLowerCase()

  if (msgLower.startsWith('feat:') || msgLower.startsWith('feature:')) {
    return 'feature'
  }
  if (
    msgLower.startsWith('refactor:') ||
    msgLower.startsWith('perf:') ||
    msgLower.startsWith('style:')
  ) {
    return 'improvement'
  }
  if (
    msgLower.startsWith('fix:') ||
    msgLower.startsWith('chore:') ||
    msgLower.startsWith('test:') ||
    msgLower.startsWith('docs:')
  ) {
    return 'patch'
  }

  // Se não tiver prefixo convencional, analisa os arquivos alterados
  let hasCodeAdditions = false
  let hasCodeModifications = false

  for (const fileLine of changedFiles) {
    const parts = fileLine.trim().split(/\s+/)
    if (parts.length < 2) continue
    const status = parts[0]
    const filePath = parts[1]

    // Ignorar arquivos de teste, configuração e docs da análise heurística de código
    if (
      filePath.includes('.test.') ||
      filePath.includes('.spec.') ||
      filePath.startsWith('.') ||
      filePath.endsWith('.md') ||
      filePath.endsWith('.json') ||
      filePath.includes('config')
    ) {
      continue
    }

    if (
      filePath.startsWith('apps/') ||
      filePath.startsWith('packages/') ||
      filePath.startsWith('runtime/')
    ) {
      if (status.includes('A')) {
        hasCodeAdditions = true
      } else if (status.includes('M')) {
        hasCodeModifications = true
      }
    }
  }

  if (hasCodeAdditions) return 'feature'
  if (hasCodeModifications) return 'improvement'
  return 'patch'
}

// 3. Incremento de versão Customizada (Major.Feature.Improvement.Patch)
export function calculateNextVersion(
  currentVersion: string,
  bumpType: 'major' | 'feature' | 'improvement' | 'patch'
): string {
  const parts = currentVersion.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) {
    return '1.0.0.0'
  }

  const [major, feature, improvement, patch] = parts

  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0.0`
    case 'feature':
      return `${major}.${feature + 1}.0.0`
    case 'improvement':
      return `${major}.${feature}.${improvement + 1}.0`
    case 'patch':
      return `${major}.${feature}.${improvement}.${patch + 1}`
    default:
      return currentVersion
  }
}

// 4. Fallback determinista caso a IA falhe
function generateDeterministicFallback(
  commitMsg: string,
  changedFiles: string[],
  classification: 'feature' | 'improvement' | 'patch'
): AIResponse {
  // Pega a primeira linha da mensagem de commit como título
  const rawTitle = commitMsg.split('\n')[0].trim()
  // Remove prefixos convencionais para exibição limpa
  const cleanTitle = rawTitle.replace(
    /^(feat|feature|fix|refactor|perf|style|chore|test|docs|ci)(\(.+\))?:\s*/i,
    ''
  )

  // Cria uma descrição básica listando arquivos
  const fileSummaries = changedFiles
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(', ')

  const fileDetails = fileSummaries ? ` (Arquivos afetados: ${fileSummaries})` : ''

  return {
    classification,
    pt: {
      title: cleanTitle || 'Atualização de código',
      description: `Alterações realizadas no repositório com foco em melhorias gerais do sistema.${fileDetails}`,
    },
    en: {
      title: cleanTitle || 'Code update',
      description: `Changes implemented in the repository focusing on general system improvements.${fileDetails}`,
    },
    es: {
      title: cleanTitle || 'Actualización de código',
      description: `Cambios realizados en el repositorio con enfoque en mejoras generales del sistema.${fileDetails}`,
    },
  }
}

// 5. Integração com a API do OpenRouter
async function fetchAIChangelog(
  apiKey: string,
  commitMsg: string,
  changedFiles: string[],
  gitDiff: string
): Promise<AIResponse | null> {
  const prompt = `Você é um redator técnico de elite. Analise o seguinte commit do git e gere notas de atualização (patch notes) profissionais, técnicas e sérias.
IMPORTANTE: Não use NENHUM emoji ou emoticons nas suas respostas. O tom deve ser estritamente sério, corporativo, premium e direto.

Informações do Commit:
- Mensagem de Commit: ${commitMsg}
- Arquivos Alterados:
${changedFiles.join('\n')}

- Conteúdo da Dificuldade (Git Diff):
${gitDiff.slice(0, 4000)}

Classifique a alteração em uma destas três categorias:
1. "feature" - novas funcionalidades perceptíveis para o usuário ou novos pacotes no monorepo.
2. "improvement" - melhorias de performance, refatorações importantes de código existente, mudanças na API.
3. "patch" - correções de bugs, pequenas tarefas de manutenção, documentação, testes ou configurações.

Você deve responder APENAS com um objeto JSON válido no seguinte formato, sem blocos de código markdown extra (como \`\`\`json) e sem explicações antes ou depois. Certifique-se de escapar as aspas internas e novas linhas corretamente para que seja um JSON válido.

{
  "classification": "feature" | "improvement" | "patch",
  "pt": {
    "title": "Título curto e profissional em Português",
    "description": "Descrição detalhada em Português (3-5 linhas) explicando as alterações e seu impacto real no sistema, em tom executivo."
  },
  "en": {
    "title": "Título curto e profissional em Inglês",
    "description": "Descrição detalhada em Inglês (3-5 linhas)..."
  },
  "es": {
    "title": "Título curto e profissional em Espanhol",
    "description": "Descrição detalhada em Espanhol (3-5 linhas)..."
  }
}`

  for (const model of FREE_MODELS) {
    console.log(`Tentando obter patch notes com o modelo OpenRouter: ${model}...`)
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/loureng/gitorch',
          'X-Title': 'GitOrch Auto Patch Notes',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(20000), // Timeout de 20 segundos por modelo
      })

      if (!response.ok) {
        console.warn(
          `Modelo ${model} retornou status HTTP ${response.status}. Tentando próximo modelo...`
        )
        continue
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const contentText = data.choices?.[0]?.message?.content?.trim()
      if (!contentText) {
        console.warn(`Modelo ${model} retornou conteúdo vazio. Tentando próximo modelo...`)
        continue
      }

      // Limpar blocos de markdown se a IA colocar de qualquer forma
      let jsonString = contentText
      if (jsonString.startsWith('```json')) {
        jsonString = jsonString
          .replace(/^```json/, '')
          .replace(/```$/, '')
          .trim()
      } else if (jsonString.startsWith('```')) {
        jsonString = jsonString.replace(/^```/, '').replace(/```$/, '').trim()
      }

      const parsed = JSON.parse(jsonString) as AIResponse
      if (
        parsed.classification &&
        parsed.pt?.title &&
        parsed.pt?.description &&
        parsed.en?.title &&
        parsed.en?.description &&
        parsed.es?.title &&
        parsed.es?.description
      ) {
        console.log(`Sucesso na geração dos patch notes com o modelo ${model}!`)
        return parsed
      } else {
        console.warn(
          `JSON retornado pelo modelo ${model} está incompleto. Tentando próximo modelo...`
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`Erro na chamada com o modelo ${model}: ${errMsg}. Tentando próximo modelo...`)
    }
  }

  return null
}

// 6. Atualização do arquivo de changelog na wiki (limitando a 30 entradas)
export function updateChangelogFile(
  filePath: string,
  lang: LanguageConfig,
  newVersion: string,
  dateStr: string,
  author: string,
  commitHash: string,
  typeText: string,
  title: string,
  description: string
): void {
  let fileContent = ''

  if (existsSync(filePath)) {
    fileContent = readFileSync(filePath, 'utf8')
  }

  // Prepara o cabeçalho padrão
  const headerContent = `${lang.header}\n\n${lang.desc}\n\n${lang.historyHeader}\n\n`

  // Prepara a nova entrada de notas de atualização (tom sério, sem emojis)
  const newEntry = `## Versão ${newVersion} - ${dateStr}
* **${lang.authorLabel}:** ${author} (Commit: \`${commitHash}\`)
* **${lang.typeLabelText}:** ${typeText}
* **${lang.changeLabelText}:** ${title}

${description}

`

  // Separar as entradas existentes para limitar a 30
  // As entradas existentes começam com "## Versão "
  let entries: string[] = []
  if (fileContent.includes('## Versão ')) {
    const parts = fileContent.split('## Versão ')
    // O primeiro pedaço (índice 0) é o cabeçalho antigo
    // Os pedaços seguintes são as entradas anteriores
    for (let i = 1; i < parts.length; i++) {
      entries.push(`## Versão ${parts[i].trim()}\n\n`)
    }
  } else if (fileContent.trim() && !fileContent.startsWith(lang.header)) {
    // Se o arquivo contiver dados legados estruturados de outro jeito, mantém como entrada isolada
    entries.push(
      fileContent
        .replace(lang.header, '')
        .replace(lang.desc, '')
        .replace(lang.historyHeader, '')
        .trim() + '\n\n'
    )
  }

  // Limita a 29 entradas antigas para que o total com a nova seja no máximo 30
  const limitedEntries = entries.slice(0, 29)

  // Junta o cabeçalho, a nova entrada e as entradas antigas
  const finalContent = headerContent + newEntry + limitedEntries.join('---\n\n')

  writeFileSync(filePath, finalContent, 'utf8')
  console.log(`Arquivo de changelog atualizado com sucesso: ${filePath}`)
}

// Execução principal
async function main() {
  console.log('Iniciando geração automatizada de Patch Notes com IA...')

  const wikiTempDir = join(process.cwd(), 'wiki_temp')
  const wikiVersionPath = join(wikiTempDir, 'version.json')
  const localVersionPath = join(process.cwd(), 'version.json')

  // 1. Obter metadados do git
  const commitHash = runGitCommand('git log -1 --format="%h"')
  const commitMsg = runGitCommand('git log -1 --format="%B"')
  const commitDate = runGitCommand('git log -1 --format="%ad" --date=format:"%Y-%m-%d %H:%M:%S"')
  const commitAuthor = runGitCommand('git log -1 --format="%an"')

  if (!commitHash) {
    console.error('Erro: Não foi possível obter informações do git. Abortando.')
    process.exit(1)
  }

  console.log(`Commit atual: ${commitHash} - Autor: ${commitAuthor}`)

  // 2. Obter diff do git (comparando com commit anterior)
  // Caso seja o primeiro commit ou não tenha HEAD~1, faz diff vazia ou com o próprio commit
  let changedFilesRaw = runGitCommand('git diff --name-status HEAD~1 HEAD 2>/dev/null || true')
  let gitDiff = runGitCommand('git diff HEAD~1 HEAD 2>/dev/null || true')

  if (!changedFilesRaw) {
    console.log('Não foi possível obter diff com HEAD~1, tentando git show para o commit atual...')
    changedFilesRaw = runGitCommand('git show --name-status --format="" HEAD')
    gitDiff = runGitCommand('git show HEAD')
  }

  const changedFiles = changedFilesRaw.split('\n').filter(Boolean)
  console.log(`Arquivos alterados no commit (${changedFiles.length}):`)
  changedFiles.forEach((f) => console.log(`  ${f}`))

  // 3. Determinar versão atual
  let currentVersion = '1.0.0.0'
  let versionSource = 'default'

  // Prioridade 1: version.json local (se alterado manualmente pelo usuário no código fonte)
  // Como o CI roda no push, o ./version.json contém as alterações desse commit.
  // Vamos ler também a versão do version.json no commit anterior (para saber se o usuário mudou o Major no commit atual)
  let lastMajor = 1
  try {
    const prevVersionStr = runGitCommand('git show HEAD~1:version.json 2>/dev/null || true')
    if (prevVersionStr) {
      const prevVer = JSON.parse(prevVersionStr) as VersionInfo
      const prevParts = prevVer.version.split('.').map(Number)
      if (prevParts.length === 4) lastMajor = prevParts[0]
    }
  } catch {
    // Ignora se não puder ler o anterior
  }

  let localMajor = 1
  let localVersion = '1.0.0.0'
  if (existsSync(localVersionPath)) {
    try {
      const localData = JSON.parse(readFileSync(localVersionPath, 'utf8')) as VersionInfo
      localVersion = localData.version
      const localParts = localVersion.split('.').map(Number)
      if (localParts.length === 4) localMajor = localParts[0]
    } catch {
      // Ignora erro de parsing
    }
  }

  // Se o Major atual mudou no local em relação ao commit anterior, usamos a versão local diretamente
  const userManuallyChangedMajor = localMajor !== lastMajor

  if (userManuallyChangedMajor) {
    currentVersion = localVersion
    versionSource = 'local manual change'
    console.log(
      `Mudança manual de versão Major detectada no repositório de código fonte: ${currentVersion}`
    )
  } else if (existsSync(wikiVersionPath)) {
    // Caso contrário, lemos a versão consolidada na Wiki
    try {
      const wikiData = JSON.parse(readFileSync(wikiVersionPath, 'utf8')) as VersionInfo
      currentVersion = wikiData.version
      versionSource = 'wiki'
      console.log(`Lendo última versão consolidada da wiki: ${currentVersion}`)
    } catch {
      // Caso dê erro, tenta o local
      if (existsSync(localVersionPath)) {
        try {
          const localData = JSON.parse(readFileSync(localVersionPath, 'utf8')) as VersionInfo
          currentVersion = localData.version
          versionSource = 'local'
        } catch {}
      }
    }
  } else if (existsSync(localVersionPath)) {
    currentVersion = localVersion
    versionSource = 'local'
  }

  console.log(`Versão base identificada: ${currentVersion} (Fonte: ${versionSource})`)

  // 4. Executar classificação heurística local para ter como opção e fallback
  const localClassification = classifyChangesHeuristically(commitMsg, changedFiles)
  console.log(`Classificação heurística local: ${localClassification}`)

  // 5. Chamar a IA para gerar os patch notes premium
  const apiKey = process.env.OPENROUTER_API_KEY
  let aiData: AIResponse | null = null

  if (apiKey) {
    aiData = await fetchAIChangelog(apiKey, commitMsg, changedFiles, gitDiff)
  } else {
    console.warn(
      'OPENROUTER_API_KEY não configurada no ambiente. Usando fallback determinístico local.'
    )
  }

  // 6. Tratar dados e definir classificação final
  let finalClassification = localClassification
  let patchNotes: AIResponse

  if (aiData) {
    finalClassification = aiData.classification
    patchNotes = aiData
    console.log(`Classificação final decidida pela IA: ${finalClassification}`)
  } else {
    console.log('IA indisponível ou falhou. Usando dados da heurística determinística local.')
    patchNotes = generateDeterministicFallback(commitMsg, changedFiles, finalClassification)
  }

  // 7. Calcular próxima versão se não foi modificada manualmente pelo usuário
  let nextVersion = currentVersion
  if (!userManuallyChangedMajor) {
    nextVersion = calculateNextVersion(currentVersion, finalClassification)
  }
  console.log(`Próxima versão calculada: ${nextVersion}`)

  // 8. Escrever a nova versão calculada em wiki_temp/version.json
  // E também no local version.json para que fiquem sintonizados
  const newVersionData: VersionInfo = {
    version: nextVersion,
    lastUpdated: new Date().toISOString(),
  }

  mkdirSync(wikiTempDir, { recursive: true })
  writeFileSync(wikiVersionPath, JSON.stringify(newVersionData, null, 2), 'utf8')
  writeFileSync(localVersionPath, JSON.stringify(newVersionData, null, 2), 'utf8')
  console.log(`Arquivos version.json atualizados com a versão ${nextVersion}`)

  // 9. Atualizar os arquivos de changelog na wiki para cada idioma
  for (const lang of LANGUAGES) {
    const changelogPath = join(wikiTempDir, lang.file)
    const typeLabel = lang.typeLabel[finalClassification] || finalClassification

    // Obter dados específicos do idioma
    const langData =
      lang.code === 'pt-br' ? patchNotes.pt : lang.code === 'en' ? patchNotes.en : patchNotes.es

    updateChangelogFile(
      changelogPath,
      lang,
      nextVersion,
      commitDate,
      commitAuthor,
      commitHash,
      typeLabel,
      langData.title,
      langData.description
    )
  }

  console.log('Geração de Patch Notes finalizada com sucesso!')
}

// Apenas executa main se for rodado diretamente (não importado em testes)
if (
  process.argv[1] &&
  (process.argv[1].endsWith('generate-patch-notes.ts') ||
    process.argv[1].endsWith('generate-patch-notes'))
) {
  main().catch((err) => {
    console.error('Erro crítico na execução principal:', err)
    process.exit(1)
  })
}
