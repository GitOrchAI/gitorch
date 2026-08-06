import { describe, it, expect } from 'vitest'
import { runIncidentSensor, collectCiFailures } from './incident-sensor.js'

function fakeFetch(opts: {
  failures?: Array<{ name: string; html_url: string; created_at: string }>
  /** Incidentes ABERTOS que a listagem por label (consistente na hora) já mostra. */
  openIncidentMarkers?: string[]
  /**
   * Se `true`, `/search/issues` devolve SEMPRE vazio — simula o lag de
   * indexação real do GitHub (uma issue criada há segundos ainda não está
   * indexada). O dedup correto NUNCA deve depender disso.
   */
  searchApiLagged?: boolean
}) {
  const created: Array<{ title: string; body: string; labels: string[] }> = []
  const urls: string[] = []
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    urls.push(u)
    const method = init?.method ?? 'GET'
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
    if (u.includes('/actions/runs')) return json({ workflow_runs: opts.failures ?? [] })
    if (u.includes('/search/issues')) {
      return json({
        items: opts.searchApiLagged
          ? []
          : (opts.openIncidentMarkers ?? []).map((m) => ({ body: `<!-- ${m} -->` })),
      })
    }
    if (u.includes('/issues?labels=') && method === 'GET') {
      // GET /repos/{repo}/issues?labels=... devolve um ARRAY direto (não
      // { items: [...] } como a search API).
      return json((opts.openIncidentMarkers ?? []).map((m) => ({ body: `<!-- ${m} -->` })))
    }
    if (u.endsWith('/issues') && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      created.push(body)
      return json({ number: 900 + created.length })
    }
    return json({})
  }) as typeof fetch
  ;(impl as unknown as { created: typeof created; urls: typeof urls }).created = created
  ;(impl as unknown as { created: typeof created; urls: typeof urls }).urls = urls
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

  // Bug real visto em produção: #20 e #25 eram o MESMO incidente
  // ("CI failing on main: Sincronizar Atualizações na Wiki Pública"),
  // criados ~3h de intervalo. Causa 1: o dedup usava `/search/issues`, cuja
  // indexação é assíncrona — uma issue criada há pouco ainda não aparece na
  // busca, então a rodada seguinte a recria. A listagem por label
  // (`GET /repos/{repo}/issues?labels=...`) é consistente na hora: não
  // depende de índice, reflete o estado real do banco do GitHub.
  it('dedup não depende da search API (indexação assíncrona): usa listagem por label, consistente na hora', async () => {
    const f = fakeFetch({
      failures: [{ name: 'Deploy', html_url: 'u1', created_at: '2026-08-06T14:15:00Z' }],
      openIncidentMarkers: ['gitorch:incident:ci:Deploy'],
      // Simula exatamente o bug: a issue já existe, mas /search/issues ainda
      // não a indexou (devolve vazio) — o comportamento antigo duplicaria.
      searchApiLagged: true,
    })

    const r = await runIncidentSensor({ repository: 'o/r', githubToken: 't', fetchImpl: f })

    expect(r.created).toHaveLength(0)
    expect(r.noOp).toBe(true)
    const urls = (f as unknown as { urls: string[] }).urls
    expect(
      urls.some((u) => u.includes('/issues?labels=gitorch%3Aincident') && u.includes('state=open'))
    ).toBe(true)
  })

  // Causa 2 do MESMO bug real (#20/#25): o fingerprint carrega o NOME do
  // workflow, texto livre quase sempre com espaço ("Sincronizar Atualizações
  // na Wiki Pública"). O regex antigo de extração do marcador parava no
  // primeiro espaço e truncava — nunca batia com o marcador completo do
  // finding novo, então o incidente era recriado em TODA varredura em que o
  // workflow continuasse falhando, mesmo com o dedup já usando a listagem
  // por label (sem depender de índice nenhum).
  it('dedup reconhece fingerprint com espaço no nome do workflow (não trunca o marcador)', async () => {
    const nomeComEspaco = 'Sincronizar Atualizações na Wiki Pública'
    const f = fakeFetch({
      failures: [{ name: nomeComEspaco, html_url: 'u1', created_at: '2026-08-06T14:15:00Z' }],
      openIncidentMarkers: [`gitorch:incident:ci:${nomeComEspaco}`],
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

  // Achado real em produção: o sensor criava a issue de incidente e parava —
  // nunca entrava no quadro Projects v2 do projeto. `moveCard` é a mesma
  // injeção que o QA já usa (qa-rails-mission.ts), construída pelo chamador
  // via createCardMover quando o projeto tem board próprio configurado.
  describe('moveCard (issue de incidente entra no quadro)', () => {
    it('incidente novo entra no quadro, na coluna inicial (todo)', async () => {
      const f = fakeFetch({
        failures: [{ name: 'Deploy', html_url: 'u1', created_at: '2026-07-05T10:00:00Z' }],
      })
      const calls: Array<[number, string]> = []
      const moveCard = async (issueNumber: number, column: string): Promise<string> => {
        calls.push([issueNumber, column])
        return `card #${issueNumber} -> Todo (set)`
      }

      const r = await runIncidentSensor({
        repository: 'o/r',
        githubToken: 't',
        fetchImpl: f,
        moveCard: moveCard as never,
      })

      expect(r.created).toHaveLength(1)
      expect(calls).toEqual([[r.created[0], 'todo']])
    })

    it('sem moveCard configurado, cria a issue normalmente (comportamento de hoje) e avisa', async () => {
      const f = fakeFetch({
        failures: [{ name: 'Deploy', html_url: 'u1', created_at: '2026-07-05T10:00:00Z' }],
      })
      const avisos: string[] = []

      const r = await runIncidentSensor({
        repository: 'o/r',
        githubToken: 't',
        fetchImpl: f,
        onWarn: (m) => avisos.push(m),
      })

      expect(r.created).toHaveLength(1)
      expect(avisos.join(' ')).toContain('quadro')
    })

    it('falha ao mover pro quadro NÃO derruba o incidente (já foi criado); avisa', async () => {
      const f = fakeFetch({
        failures: [{ name: 'Deploy', html_url: 'u1', created_at: '2026-07-05T10:00:00Z' }],
      })
      const avisos: string[] = []
      const moveCard = async (): Promise<string> => {
        throw new Error('board sem coluna Todo configurada')
      }

      const r = await runIncidentSensor({
        repository: 'o/r',
        githubToken: 't',
        fetchImpl: f,
        moveCard: moveCard as never,
        onWarn: (m) => avisos.push(m),
      })

      expect(r.created).toHaveLength(1)
      expect(avisos.join(' ')).toContain('quadro')
    })
  })
})
