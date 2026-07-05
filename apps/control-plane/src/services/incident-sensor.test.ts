import { describe, it, expect } from 'vitest'
import { runIncidentSensor, collectCiFailures } from './incident-sensor.js'

function fakeFetch(opts: {
  failures?: Array<{ name: string; html_url: string; created_at: string }>
  openIncidentMarkers?: string[]
}) {
  const created: Array<{ title: string; body: string; labels: string[] }> = []
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
    if (u.includes('/actions/runs')) return json({ workflow_runs: opts.failures ?? [] })
    if (u.includes('/search/issues')) {
      return json({
        items: (opts.openIncidentMarkers ?? []).map((m) => ({ body: `<!-- ${m} -->` })),
      })
    }
    if (u.endsWith('/issues') && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      created.push(body)
      return json({ number: 900 + created.length })
    }
    return json({})
  }) as typeof fetch
  ;(impl as unknown as { created: typeof created }).created = created
  return impl
}

describe('collectCiFailures', () => {
  it('agrupa falhas por workflow com fingerprint estável', async () => {
    const f = fakeFetch({
      failures: [
        { name: 'Deploy', html_url: 'u1', created_at: '2026-07-05T10:00:00Z' },
        { name: 'Deploy', html_url: 'u2', created_at: '2026-07-05T11:00:00Z' },
        { name: 'Tests', html_url: 'u3', created_at: '2026-07-05T12:00:00Z' },
      ],
    })
    const findings = await collectCiFailures({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(findings).toHaveLength(2)
    expect(findings[0]!.fingerprint).toBe('ci:Deploy')
    expect(findings[0]!.evidence).toContain('2 recent failure(s)')
  })
})

describe('runIncidentSensor', () => {
  it('cria issue de incidente com label e marker; PO tria depois (sem prioridade aqui)', async () => {
    const f = fakeFetch({
      failures: [{ name: 'Deploy', html_url: 'u1', created_at: '2026-07-05T10:00:00Z' }],
    })
    const created = (f as unknown as { created: Array<{ labels: string[]; body: string }> }).created
    const r = await runIncidentSensor({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(r.created).toHaveLength(1)
    expect(created[0]!.labels).toEqual(['gitorch:incident'])
    expect(created[0]!.body).toContain('gitorch:incident:ci:Deploy')
    // sensor nunca prioriza: nenhuma label P0..P3 (a nota no corpo só explica)
    expect(created[0]!.labels.some((l) => /^P[0-3]$/.test(l))).toBe(false)
  })

  it('idempotente: incidente já aberto com o mesmo fingerprint não duplica', async () => {
    const f = fakeFetch({
      failures: [{ name: 'Deploy', html_url: 'u1', created_at: '2026-07-05T10:00:00Z' }],
      openIncidentMarkers: ['gitorch:incident:ci:Deploy'],
    })
    const r = await runIncidentSensor({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(r.created).toHaveLength(0)
    expect(r.noOp).toBe(true)
  })

  it('cap protege contra tempestade de incidentes', async () => {
    const f = fakeFetch({
      failures: [
        { name: 'A', html_url: 'u', created_at: '2026-07-05T10:00:00Z' },
        { name: 'B', html_url: 'u', created_at: '2026-07-05T10:00:00Z' },
        { name: 'C', html_url: 'u', created_at: '2026-07-05T10:00:00Z' },
        { name: 'D', html_url: 'u', created_at: '2026-07-05T10:00:00Z' },
      ],
    })
    const r = await runIncidentSensor({
      repository: 'o/r',
      githubToken: 't',
      cap: 2,
      fetchImpl: f,
    })
    expect(r.created).toHaveLength(2)
  })

  it('sem falhas → tudo quieto', async () => {
    const f = fakeFetch({})
    const r = await runIncidentSensor({ repository: 'o/r', githubToken: 't', fetchImpl: f })
    expect(r.noOp).toBe(true)
    expect(r.output).toContain('no findings')
  })
})
