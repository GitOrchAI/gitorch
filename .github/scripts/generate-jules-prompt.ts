/**
 * Dependabot Data Fetcher and Jules Prompt Generator
 *
 * Fetches ALL Dependabot alert data via GitHub API and generates a complete,
 * rich Jules prompt template with CVSS, CWE, EPSS, vulnerable ranges,
 * patched versions, references, and exact upgrade commands.
 */

import { Octokit } from '@octokit/rest'
import { OpenRouterClient, createOpenRouterClientFromEnv } from './lib/openrouter-client.js'
import { z } from 'zod'

// Types for Dependabot alert data
const DependabotAlertSchema = z.object({
  number: z.number(),
  state: z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']),
  dependency: z.object({
    package: z.object({
      name: z.string(),
      ecosystem: z.string(),
    }),
    manifest_path: z.string().optional(),
    relationship: z.string().optional(),
    scope: z.string().optional(),
  }),
  security_advisory: z.object({
    // .nullish() = aceita string, undefined OU null. Alertas sem CVE retornam cve_id: null
    // (ex.: alertas de severidade média que só têm GHSA) — antes quebrava com ZodError.
    ghsa_id: z.string().nullish(),
    cve_id: z.string().nullish(),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).nullish(),
    classification: z.string().nullish(),
    published_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    cvss_severities: z
      .object({
        cvss_v3: z
          .object({
            score: z.number().nullable().optional(),
            vector_string: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
        cvss_v4: z
          .object({
            score: z.number().nullable().optional(),
            vector_string: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    cwes: z
      .array(
        z.object({
          cwe_id: z.string(),
          name: z.string(),
        })
      )
      .optional(),
    epss: z
      .object({
        percentage: z.number().optional(),
        percentile: z.number().optional(),
      })
      .optional(),
    vulnerabilities: z
      .array(
        z.object({
          package: z.object({
            name: z.string(),
            ecosystem: z.string(),
          }),
          vulnerable_version_range: z.string().optional(),
          first_patched_version: z
            .object({
              identifier: z.string(),
            })
            .optional(),
          severity: z.string().optional(),
        })
      )
      .optional(),
    references: z
      .array(
        z.object({
          url: z.string().nullable(),
        })
      )
      .optional(),
  }),
})

export type DependabotAlert = z.infer<typeof DependabotAlertSchema>

const GeneratedPromptSchema = z.object({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
})

export type GeneratedPrompt = z.infer<typeof GeneratedPromptSchema>

/**
 * Fetches a Dependabot alert by number
 */
export async function fetchDependabotAlert(
  octokit: Octokit,
  owner: string,
  repo: string,
  alertNumber: number
): Promise<DependabotAlert | null> {
  try {
    const response = await octokit.rest.dependabot.getAlert({
      owner,
      repo,
      alert_number: alertNumber,
    })

    return DependabotAlertSchema.parse(response.data)
  } catch (error) {
    console.error(`Failed to fetch Dependabot alert #${alertNumber}:`, error)
    return null
  }
}

/**
 * Formats CVSS information
 */
type CVSSType =
  | { score?: number | null | undefined; vector_string?: string | null | undefined }
  | null
  | undefined

function formatCVSS(cvss: CVSSType): string {
  if (!cvss) return 'N/A'
  const parts: string[] = []
  if (cvss.score !== undefined && cvss.score !== null) parts.push(`Score: ${cvss.score}`)
  if (cvss.vector_string) parts.push(`Vector: \`${cvss.vector_string}\``)
  return parts.length ? parts.join(' | ') : 'N/A'
}

type CVSSAllType =
  | {
      cvss_v3?:
        | { score?: number | null | undefined; vector_string?: string | null | undefined }
        | null
        | undefined
      cvss_v4?:
        | { score?: number | null | undefined; vector_string?: string | null | undefined }
        | null
        | undefined
    }
  | null
  | undefined

function formatCVSSAll(cvssSeverities: CVSSAllType): string {
  if (!cvssSeverities) return 'N/A'
  const lines: string[] = []
  if (
    cvssSeverities.cvss_v3 &&
    cvssSeverities.cvss_v3.score !== undefined &&
    cvssSeverities.cvss_v3.score !== null
  )
    lines.push(`**CVSS v3.1:** ${formatCVSS(cvssSeverities.cvss_v3)}`)
  if (
    cvssSeverities.cvss_v4 &&
    cvssSeverities.cvss_v4.score !== undefined &&
    cvssSeverities.cvss_v4.score !== null
  )
    lines.push(`**CVSS v4.0:** ${formatCVSS(cvssSeverities.cvss_v4)}`)
  return lines.length ? lines.join('\n') : 'N/A'
}

function formatCWEs(cwes?: Array<{ cwe_id: string; name: string }>): string {
  if (!cwes || !cwes.length) return 'Nenhum CWE associado'
  return cwes.map((c) => `- **CWE-${c.cwe_id}**: ${c.name}`).join('\n')
}

type VulnType =
  | {
      package: { name: string; ecosystem: string }
      vulnerable_version_range?: string | null | undefined
      first_patched_version?: { identifier: string } | null | undefined
      severity?: string | null | undefined
    }
  | undefined

function formatVulnVersions(vulns?: Array<VulnType>): string {
  if (!vulns || !vulns.length) return 'N/A'
  return vulns
    .map((v) => {
      const patched = v?.first_patched_version?.identifier
        ? `→ Corrigido em **${v.first_patched_version.identifier}**`
        : ''
      const sev = v?.severity ? ` [${v.severity}]` : ''
      return `- **${v?.package.name}** (${v?.package.ecosystem}): \`${v?.vulnerable_version_range || 'N/A'}\` ${patched}${sev}`
    })
    .join('\n')
}

type EPSType =
  | { percentage?: number | null | undefined; percentile?: number | null | undefined }
  | null
  | undefined

function formatEPSS(epss: EPSType): string {
  if (!epss) return 'N/A'
  const pct =
    epss.percentage !== undefined && epss.percentage !== null
      ? (epss.percentage * 100).toFixed(4)
      : 'N/A'
  const pctl =
    epss.percentile !== undefined && epss.percentile !== null
      ? (epss.percentile * 100).toFixed(2)
      : 'N/A'
  return `**Prob. exploração:** ${pct}% (Percentil: ${pctl}%)`
}

function formatReferences(refs?: Array<{ url: string | null }>): string {
  if (!refs || !refs.length) return 'Nenhuma referência'
  return refs.map((r) => `- [${r.url || 'N/A'}](${r.url || '#'})`).join('\n')
}

/**
 * Generates the complete Jules prompt using jules-awesome-list patterns
 * and all Dependabot alert data
 */
function generateJulesPrompt(alert: DependabotAlert): GeneratedPrompt {
  const adv = alert.security_advisory
  const dep = alert.dependency
  const pkg = dep.package
  const vulns = adv.vulnerabilities || []

  const firstVuln = vulns[0]
  const patchedVersion = firstVuln?.first_patched_version?.identifier
  const vulnerableRange = firstVuln?.vulnerable_version_range

  // Build exact pnpm commands
  let upgradeCommands = ''
  if (patchedVersion) {
    upgradeCommands = `\`\`\`bash
# 1. Atualização direta para versão corrigida
pnpm add ${pkg.name}@${patchedVersion}

# 2. Validação com lockfile congelado (evita atualizações não intencionais)
pnpm install --frozen-lockfile

# 3. Executar testes para verificar compatibilidade
pnpm test
\`\`\``
  } else {
    upgradeCommands = `\`\`\`bash
# 1. Atualização para latest (quando não há versão específica corrigida)
pnpm add ${pkg.name}@latest

# 2. Validação com lockfile congelado
pnpm install --frozen-lockfile

# 3. Executar testes
pnpm test
\`\`\``
  }

  const marker = `<!-- dependabot-alert-number: ${alert.number} -->`

  const body = `## 🐞 Issue de Segurança: Dependabot Alert

### Cabeçalho Técnico

| Campo | Valor |
|-------|-------|
| **Pacote Afetado** | \`${pkg.name}\` |
| **Ecosistema** | ${pkg.ecosystem} |
| **Arquivo de Manifesto** | \`${dep.manifest_path || 'Não informado'}\` |
| **Relacionamento** | ${dep.relationship || 'Não informado'} |
| **Escopo** | ${dep.scope || 'Não informado'} |
| **Alerta Dependabot** | #${alert.number} |
| **CVE ID** | ${adv.cve_id || 'N/A'} |
| **GHSA ID** | ${adv.ghsa_id || 'N/A'} |
| **Severidade** | ${adv.severity?.toUpperCase() || 'DESCONHECIDA'} |
| **Classificação** | ${adv.classification || 'Não informado'} |
| **Estado** | ${alert.state} |
| **Publicado em** | ${adv.published_at || 'Não informado'} |
| **Atualizado em** | ${adv.updated_at || 'Não informado'} |

### Métricas de Severidade

${formatCVSSAll(adv.cvss_severities as CVSSAllType)}

### CWEs Associados

${formatCWEs(adv.cwes)}

### EPSS (Exploit Prediction Scoring System)

${formatEPSS(adv.epss)}

### Versões Vulneráveis e Correção

${formatVulnVersions(vulns)}

---

### 1. Resumo (Negócio)

${adv.summary || 'Não informado'}

### 2. Descrição Técnica

${adv.description ? adv.description.substring(0, 5000) : 'Não informada'}

### 3. Impacto de Segurança

| Categoria | Classificação | Detalhamento |
| :--- | :--- | :--- |
| **STRIDE** | Baseado na vulnerabilidade | Análise pendente |
| **OWASP Top 10** | Baseado na vulnerabilidade | Análise pendente |

**Cenários de Ataque:**
1. Análise pendente - Jules deve preencher com base no código afetado
2. Análise pendente - Jules deve preencher com base no código afetado

### 4. Plano de Mitigação

#### Opção A: Atualização Direta (RECOMENDADA)

${upgradeCommands}

#### Opção B: Workaround (se atualização impossível)

Isolamento do componente vulnerável via wrapper/adapter pattern.
Requer análise de código pelo Jules para identificar pontos de uso.

### 5. Instruções para o Jules

Você é um agente de segurança especializado em correção de vulnerabilidades de dependências.

**TAREFA:** Corrigir a vulnerabilidade no pacote \`${pkg.name}\` atualizando para versão segura.

**CONTEXTO DO REPOSITÓRIO:**
- Este é um projeto Node.js/TypeScript usando pnpm
- O arquivo de manifesto está em: \`${dep.manifest_path || 'package.json'}\`
- A versão vulnerável é: \`${vulnerableRange || 'desconhecida'}\`
- A versão corrigida é: \`${patchedVersion || 'latest'}\`

**PASSOS OBRIGATÓRIOS:**
1. **Análise** - Identifique todos os arquivos que importam/usam \`${pkg.name}\`
2. **Atualização** - Execute os comandos exatos acima para atualizar a dependência
3. **Validação** - Rode \`pnpm install --frozen-lockfile\` e \`pnpm test\`
4. **Correção de Breaking Changes** - Se houver breaking changes, atualize o código afetado
5. **Commit e PR** - Faça commit das alterações e abra PR com descrição completa

**REGRAS CRÍTICAS:**
- NÃO altere outras dependências além de \`${pkg.name}\`
- Mantenha o lockfile consistente (\`--frozen-lockfile\`)
- Todos os testes existentes devem passar
- Se testes falharem, corrija o código, não pule os testes
- O PR deve ser aberto na branch \`dependabot/${pkg.ecosystem}/${pkg.name}/${patchedVersion || 'latest'}\`

### 6. Comandos de Verificação

\`\`\`bash
# Verificar versão atual
pnpm list ${pkg.name}

# Verificar dependências vulneráveis
pnpm audit

# Verificar lockfile
cat pnpm-lock.yaml | grep -A 5 "${pkg.name}"
\`\`\`

### 7. Referências

${formatReferences(adv.references)}

---

${marker}`

  const title = `[Segurança] Dependabot: Vulnerabilidade em ${pkg.name} (${adv.severity?.toUpperCase() || 'UNKNOWN'})`

  const labels = ['jules', 'dependabot', 'security', adv.severity || 'unknown', 'P0']

  return { title, body, labels }
}

/**
 * Enriches the prompt with OpenRouter LLM (optional enhancement)
 */
async function enrichWithLLM(
  client: OpenRouterClient | null,
  basePrompt: GeneratedPrompt,
  alert: DependabotAlert
): Promise<GeneratedPrompt> {
  if (!client) {
    console.log('OpenRouter client not configured, using base prompt')
    return basePrompt
  }

  try {
    const systemPrompt = `Você é um engenheiro de segurança sênior especializado em correção de vulnerabilidades de dependências. 
Sua tarefa é APENAS APERFEIÇOAR o prompt base para o Jules, mantendo TODOS os dados reais intactos.
REGRAS:
1. NÃO remova ou altere dados reais (CVEs, CWEs, CVSS, versões, comandos)
2. ADICIONE contexto específico do repositório se identificável
3. MELHORE a clareza das instruções para o Jules
4. MANTENHA o marcador <!-- dependabot-alert-number: X --> no final
5. Responda APENAS com o JSON: {title, body, labels}`

    const userPrompt = `Prompt base para enriquecer:
\`\`\`json
${JSON.stringify(basePrompt, null, 2)}
\`\`\`

Dados completos do alerta:
\`\`\`json
${JSON.stringify(alert, null, 2)}
\`\`\`

Melhore o prompt para o Jules focando em:
- Instruções mais específicas sobre breaking changes conhecidos do pacote
- Identificação de arquivos de teste que podem quebrar
- Comandos de verificação adicionais específicos do ecossistema ${alert.dependency.package.ecosystem}`

    const enhanced = await client.completeWithSystem(systemPrompt, userPrompt, {
      maxTokens: 12000,
      temperature: 0.1,
    })

    // Try to parse JSON response
    try {
      const parsed = JSON.parse(enhanced)
      if (parsed.title && parsed.body && parsed.labels) {
        // Ensure marker is present
        if (!parsed.body.includes(`dependabot-alert-number: ${alert.number}`)) {
          parsed.body += `\n\n<!-- dependabot-alert-number: ${alert.number} -->`
        }
        return parsed
      }
    } catch {
      console.warn('LLM response not valid JSON, using base prompt')
    }

    return basePrompt
  } catch (error) {
    console.error('LLM enrichment failed:', error)
    return basePrompt
  }
}

/**
 * Main function to generate Jules prompt for a Dependabot alert
 */
export async function generateJulesPromptForAlert(
  octokit: Octokit,
  owner: string,
  repo: string,
  alertNumber: number,
  llmClient: OpenRouterClient | null = null
): Promise<GeneratedPrompt | null> {
  console.log(`Fetching Dependabot alert #${alertNumber}...`)
  const alert = await fetchDependabotAlert(octokit, owner, repo, alertNumber)

  if (!alert) {
    console.error(`Alert #${alertNumber} not found or invalid`)
    return null
  }

  console.log(`Generating base prompt for ${alert.dependency.package.name}...`)
  const basePrompt = generateJulesPrompt(alert)

  console.log('Enriching with LLM...')
  const enhancedPrompt = await enrichWithLLM(llmClient, basePrompt, alert)

  return enhancedPrompt
}

/**
 * Fetches all open Dependabot alerts
 */
export async function fetchAllOpenDependabotAlerts(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<DependabotAlert[]> {
  const alerts: DependabotAlert[] = []

  for await (const response of octokit.paginate.iterator(
    octokit.rest.dependabot.listAlertsForRepo,
    { owner, repo, state: 'open', per_page: 100 }
  )) {
    for (const alert of response.data) {
      const parsed = DependabotAlertSchema.safeParse(alert)
      if (parsed.success) {
        alerts.push(parsed.data)
      }
    }
  }

  return alerts
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2)
  const alertNumber = args[0] ? parseInt(args[0], 10) : null

  const env = process.env as Record<string, string | undefined>
  const owner = env['REPO_OWNER'] || 'loureng'
  const repo = env['REPO_NAME'] || 'gitorch'
  const githubToken = env['SECURITY_PAT'] || env['GITHUB_TOKEN']

  if (!githubToken) {
    console.error('SECURITY_PAT or GITHUB_TOKEN environment variable is required')
    process.exit(1)
  }

  const octokit = new Octokit({ auth: githubToken })
  const llmClient = env['OPENROUTER_API_KEY'] ? createOpenRouterClientFromEnv() : null

  if (alertNumber) {
    const prompt = await generateJulesPromptForAlert(octokit, owner, repo, alertNumber, llmClient)
    if (prompt) {
      console.log('=== GENERATED PROMPT ===')
      console.log(JSON.stringify(prompt, null, 2))
      console.log('=== END PROMPT ===')
    } else {
      process.exit(1)
    }
  } else {
    const alerts = await fetchAllOpenDependabotAlerts(octokit, owner, repo)
    console.log(`Found ${alerts.length} open Dependabot alerts`)
    for (const alert of alerts) {
      console.log(
        `  #${alert.number}: ${alert.dependency.package.name} (${alert.security_advisory.severity})`
      )
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
