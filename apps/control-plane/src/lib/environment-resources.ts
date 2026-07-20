/**
 * Tradução do `resourcesLock` cru (o `<env>/.gitorch/env-lock.json` gerado
 * pelo bootstrap privado, ver ClientEnvironmentService.bootstrapResources)
 * para o que o WIZARD pode mostrar ao dono: nome + versão de cada motor
 * instalado, e o commit CURTO dos recursos do GitOrch. NUNCA expõe os campos
 * internos do lock (`npm`, `cache`, `sha256`, `binary`, `arch`, `repo`) — só
 * o que o cliente precisa para confirmar que o ambiente dele está com as
 * versões certas (spec W1: o gate desta fase é o dono VER a versão real).
 *
 * Honestidade acima de tudo (mesmo espírito de bootstrapResources): qualquer
 * coisa que não seja um lock bem-formado — ainda não gerado, JSON
 * inesperado, sem nenhum motor reconhecido, sem o commit dos recursos —
 * vira `null`. O front mostra "preparando", nunca um bloco de versões pela
 * metade ou inventado.
 */

export interface EnvironmentEngineVersion {
  name: string
  version: string
}

export interface EnvironmentResourcesSummary {
  engines: EnvironmentEngineVersion[]
  commit: string
}

// Ordem fixa e conhecida — os 3 motores que o wizard sempre ofereceu (mesmos
// ids de runtime usados em StepConnectEngine/F6_AGENT_ROLES). Qualquer outra
// chave dentro de `engines` no lock é ignorada, não quebra os demais.
const KNOWN_ENGINES = ['claude', 'codex', 'antigravity'] as const

// Tamanho de um SHA git curto — o mesmo corte que `git rev-parse --short`
// usa por padrão. Um commit menor que isto fica do jeito que está.
const SHORT_COMMIT_LENGTH = 7

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function summarizeResourcesLock(raw: unknown): EnvironmentResourcesSummary | null {
  if (!isPlainObject(raw)) return null

  const enginesRaw = raw['engines']
  if (!isPlainObject(enginesRaw)) return null

  const engines: EnvironmentEngineVersion[] = []
  for (const name of KNOWN_ENGINES) {
    const entry = enginesRaw[name]
    if (!isPlainObject(entry)) continue
    const version = entry['version']
    if (typeof version === 'string' && version.trim()) {
      engines.push({ name, version: version.trim() })
    }
  }
  // Sem nenhum motor reconhecido, o bloco não tem o que mostrar — trata como
  // se o lock não tivesse sido gerado ainda.
  if (engines.length === 0) return null

  const resourcesRaw = raw['resources']
  if (!isPlainObject(resourcesRaw)) return null
  const commitRaw = resourcesRaw['commit']
  if (typeof commitRaw !== 'string' || !commitRaw.trim()) return null
  const commit = commitRaw.trim().slice(0, SHORT_COMMIT_LENGTH)

  return { engines, commit }
}
