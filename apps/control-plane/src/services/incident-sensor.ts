import { GithubExecutionError } from './github-errors.js'

// SENSOR de incidentes (os "olhos" do GitOrch): coleta erros REAIS do projeto
// e os transforma em issues `gitorch:incident` — tipo próprio, fora da árvore
// de wish/épicos. O sensor NUNCA prioriza nem delega: quem tria a criticidade
// (P0..P3) e decide furar a fila da sprint é o PO. 100% determinístico e
// idempotente por fingerprint (re-rodar não duplica).
//
// Fontes plugáveis; a primeira é falha de workflow na branch principal do
// cliente (disponível com o token existente). Sentry/logs entram como novas
// fontes quando o projeto fornecer credencial.

export const INCIDENT_LABEL = 'gitorch:incident'

export interface SensorFinding {
  /** Identidade estável do problema (dedup) — ex.: "ci:Nome do Workflow". */
  fingerprint: string
  title: string
  /** Evidência legível (o PO tria com base nisso). */
  evidence: string
  source: string
}

export interface IncidentSensorOptions {
  repository: string
  githubToken: string
  /** Máximo de incidentes novos por varredura (proteção contra tempestade). */
  cap?: number
  fetchImpl?: typeof fetch
}

export interface IncidentSensorResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  created: number[]
}

const incidentMarker = (fingerprint: string): string => `gitorch:incident:${fingerprint}`

/** Fonte 1 — falhas de workflow na branch principal (agrupadas por workflow). */
export async function collectCiFailures(
  options: Pick<IncidentSensorOptions, 'repository' | 'githubToken' | 'fetchImpl'>
): Promise<SensorFinding[]> {
  const f = options.fetchImpl ?? fetch
  const resp = await f(
    `https://api.github.com/repos/${options.repository}/actions/runs?branch=main&status=failure&per_page=20`,
    {
      headers: {
        authorization: `token ${options.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
      },
    }
  )
  if (!resp.ok) {
    throw new GithubExecutionError(`sensor: workflow runs lookup failed (${resp.status})`)
  }
  const data = (await resp.json()) as {
    workflow_runs?: Array<{ name?: string; html_url?: string; created_at?: string }>
  }
  const byWorkflow = new Map<string, Array<{ url: string; at: string }>>()
  for (const run of data.workflow_runs ?? []) {
    const name = run.name ?? 'unknown workflow'
    const list = byWorkflow.get(name) ?? []
    list.push({ url: run.html_url ?? '', at: (run.created_at ?? '').slice(0, 10) })
    byWorkflow.set(name, list)
  }
  return [...byWorkflow.entries()].map(([name, runs]) => ({
    fingerprint: `ci:${name}`,
    title: `[Incident] CI failing on main: ${name}`,
    evidence: [
      `Workflow "${name}" is FAILING on the main branch (${runs.length} recent failure(s)).`,
      ...runs.slice(0, 5).map((r) => `- ${r.at}: ${r.url}`),
    ].join('\n'),
    source: 'github-actions',
  }))
}

export async function runIncidentSensor(
  options: IncidentSensorOptions
): Promise<IncidentSensorResult> {
  const f = options.fetchImpl ?? fetch
  const cap = options.cap ?? 3

  const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const resp = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new GithubExecutionError(
        `GitHub ${method} ${path} failed (${resp.status}): ${detail.slice(0, 150)}`
      )
    }
    return resp.json().catch(() => ({}))
  }

  const findings = await collectCiFailures(options)
  if (findings.length === 0) {
    return { exitCode: 0, output: 'sensor: no findings.', stderr: '', noOp: true, created: [] }
  }

  // Dedup por fingerprint: UMA busca pelos markers de incidente abertos.
  const q = encodeURIComponent(`repo:${options.repository} in:body "gitorch:incident:" state:open`)
  const existing = (await gh('GET', `/search/issues?q=${q}&per_page=100`)) as {
    items?: Array<{ body?: string }>
  }
  const openMarkers = new Set(
    (existing.items ?? [])
      .map((i) => i.body?.match(/<!--\s*(gitorch:incident:[^\s>]+)\s*-->/)?.[1])
      .filter((m): m is string => Boolean(m))
  )

  const created: number[] = []
  for (const finding of findings) {
    if (created.length >= cap) break
    const marker = incidentMarker(finding.fingerprint)
    if (openMarkers.has(marker)) continue
    const issue = (await gh('POST', `/repos/${options.repository}/issues`, {
      title: finding.title,
      labels: [INCIDENT_LABEL],
      body: [
        `<!-- ${marker} -->`,
        `## Evidence`,
        finding.evidence,
        '',
        `## Source`,
        `Sensor: ${finding.source} (detected automatically by GitOrch).`,
        '',
        '_Aguardando triagem do PO (P0–P3). Este incidente não entra em sprint até o PO liberar._',
      ].join('\n'),
    })) as { number?: number }
    if (issue.number) created.push(issue.number)
  }

  return {
    exitCode: 0,
    output:
      created.length > 0
        ? `sensor: opened ${created.length} incident(s): ${created.map((n) => `#${n}`).join(', ')}.`
        : 'sensor: findings already tracked (no new incident).',
    stderr: '',
    noOp: created.length === 0,
    created,
  }
}
