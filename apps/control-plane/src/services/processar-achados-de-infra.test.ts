import { describe, it, expect, vi } from 'vitest'
import type { AchadoDeInfra } from './incidente-ci.js'
import type { DoDFields } from '@gitorch/cadence'
import { runAnaliseCausaDeInfra, runIssuePadraoDeInfra } from './analise-causa-de-infra.js'

const DOD: DoDFields = {
  titulo: 'Consertar X',
  goal: 'g',
  taskDetails: 'td',
  taskDescription: 'tdesc',
  implementationGuide: '1. faz\n2. testa',
  verificationCriteria: 'roda verde no CI',
  dependencies: 'nenhuma',
  relatedFiles: '.github/workflows/ci.yml',
  notes: 'escopo focado',
}

// A análise e a redação reais rodam via `execute` (motor) dentro de
// analise-causa-de-infra; aqui focamos no ROTEAMENTO e nos efeitos do driver.
vi.mock('./analise-causa-de-infra.js', () => ({
  runAnaliseCausaDeInfra: vi.fn(async () => ({
    causaRaiz: 'script build ausente',
    arquivosAfetados: 'package.json',
    criterioDeVerificacao: 'CI verde',
    escopo: 'só o script',
    riscoDeRegressao: 'baixo',
  })),
  runIssuePadraoDeInfra: vi.fn(async () => DOD),
}))

const { alvoDaClasse, scaffoldingObsoleto, processarAchadosDeInfra } =
  await import('./processar-achados-de-infra.js')
type ProcessarAchadosDeps = Parameters<typeof processarAchadosDeInfra>[0]

function achado(over: Partial<AchadoDeInfra> = {}): AchadoDeInfra {
  return {
    classe: 'ci-do-cliente',
    identidadeEstavel: 'wf:11',
    titulo: 'Workflow "CI" falhou na main',
    travaMerge: true,
    evidencia: 'npm ERR! missing script: build',
    paths: ['.github/workflows/ci.yml'],
    ...over,
  }
}

function deps(over: Partial<ProcessarAchadosDeps> = {}): ProcessarAchadosDeps {
  return {
    achados: [achado()],
    projectId: 'proj-1',
    repository: 'acme/api',
    execute: async () => '{}',
    incidentesAbertos: async () => [],
    criarIssueNoCliente: vi.fn(async () => 501),
    criarIssueNoProduto: vi.fn(async () => 777),
    criarProposta: vi.fn(async () => 901),
    perguntarAoDono: vi.fn(async () => undefined),
    avisarDono: vi.fn(async () => undefined),
    registrarIncidente: vi.fn(async () => undefined),
    ...over,
  }
}

describe('alvoDaClasse', () => {
  it('classes do cliente → repo-do-cliente', () => {
    for (const c of ['ci-do-cliente', 'config-de-actions', 'alerta-de-seguranca'] as const) {
      expect(alvoDaClasse(c)).toBe('repo-do-cliente')
    }
  })
  it('scaffolding-do-gitorch → repo-do-produto; workflow-morto → nenhum', () => {
    expect(alvoDaClasse('scaffolding-do-gitorch')).toBe('repo-do-produto')
    expect(alvoDaClasse('workflow-morto')).toBe('nenhum')
  })
  // L4-T2 (D63): automação do cliente E o job do Dependabot (as 14 sessões
  // medidas de "npm_and_yarn in /.github/scripts" eram exatamente isto) NÃO
  // viram incidente P0 delegável — viram PROPOSTA ao dono.
  it('automacao e dependabot-travado → proposta', () => {
    expect(alvoDaClasse('automacao')).toBe('proposta')
    expect(alvoDaClasse('dependabot-travado')).toBe('proposta')
  })
})

describe('scaffoldingObsoleto', () => {
  it('pega os workflows de auto-merge que o control-plane substituiu', () => {
    expect(scaffoldingObsoleto(['.github/workflows/auto-merge.yml'])).toBe(true)
    expect(scaffoldingObsoleto(['.github/workflows/jules-auto-merge.yml'])).toBe(true)
    expect(scaffoldingObsoleto(['.github/workflows/dependabot-to-jules.yml'])).toBe(false)
  })
})

describe('processarAchadosDeInfra', () => {
  it('achado do cliente → 1 issue no repo do cliente + upsert do incidente, nada no produto', async () => {
    const d = deps()
    const r = await processarAchadosDeInfra(d)
    expect(r.issuesNoCliente).toEqual([501])
    expect(r.issuesNoProduto).toEqual([])
    expect(d.criarIssueNoCliente).toHaveBeenCalledOnce()
    expect(d.criarIssueNoProduto).not.toHaveBeenCalled()
    expect(d.registrarIncidente).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', identidadeEstavel: 'wf:11', issueNumber: 501 })
    )
    expect(d.avisarDono).not.toHaveBeenCalled()
  })

  it('achado de encanamento obsoleto → issue no produto + Telegram, NUNCA o PO do cliente', async () => {
    const d = deps({
      achados: [
        achado({
          classe: 'scaffolding-do-gitorch',
          identidadeEstavel: 'wf:40',
          paths: ['.github/workflows/auto-merge.yml'],
        }),
      ],
    })
    const r = await processarAchadosDeInfra(d)
    expect(r.issuesNoProduto).toEqual([777])
    expect(r.issuesNoCliente).toEqual([])
    expect(d.criarIssueNoCliente).not.toHaveBeenCalled()
    expect(d.avisarDono).toHaveBeenCalledOnce()
    const texto = (d.avisarDono as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(texto).toContain('REMOÇÃO')
  })

  it('workflow-morto → só log, nenhuma issue', async () => {
    const d = deps({ achados: [achado({ classe: 'workflow-morto', identidadeEstavel: 'wf:9' })] })
    const r = await processarAchadosDeInfra(d)
    expect(r.ignorados).toEqual(['wf:9'])
    expect(d.criarIssueNoCliente).not.toHaveBeenCalled()
  })

  it('incidente já com issue aberta → não reanalisa (jaRastreados)', async () => {
    const d = deps({
      incidentesAbertos: async () => [{ identidadeEstavel: 'wf:11', issueNumber: 42 }],
    })
    const r = await processarAchadosDeInfra(d)
    expect(r.jaRastreados).toEqual(['wf:11'])
    expect(d.criarIssueNoCliente).not.toHaveBeenCalled()
  })

  it('teto de achados processados por passada', async () => {
    const d = deps({
      achados: [
        achado({ identidadeEstavel: 'wf:1' }),
        achado({ identidadeEstavel: 'wf:2' }),
        achado({ identidadeEstavel: 'wf:3' }),
        achado({ identidadeEstavel: 'wf:4' }),
      ],
      teto: 2,
    })
    const r = await processarAchadosDeInfra(d)
    expect(r.issuesNoCliente).toHaveLength(2)
  })

  // L4-T2 (D63): achado de automação → proposta ao dono, NUNCA incidente P0.
  it('achado "automacao" → 1 criarProposta + 1 perguntarAoDono + 1 registrarIncidente, ZERO issue no cliente, ZERO análise', async () => {
    vi.mocked(runAnaliseCausaDeInfra).mockClear()
    vi.mocked(runIssuePadraoDeInfra).mockClear()
    const d = deps({
      achados: [
        achado({
          classe: 'automacao',
          identidadeEstavel: 'wf:77',
          titulo: 'Workflow "Auto Merge Checker" falha',
          paths: ['.github/workflows/auto-merge-checker.yml'],
        }),
      ],
    })
    const r = await processarAchadosDeInfra(d)
    expect(d.criarProposta).toHaveBeenCalledOnce()
    expect(d.perguntarAoDono).toHaveBeenCalledOnce()
    expect(d.registrarIncidente).toHaveBeenCalledWith(
      expect.objectContaining({ classe: 'automacao', identidadeEstavel: 'wf:77', issueNumber: 901 })
    )
    expect(d.criarIssueNoCliente).not.toHaveBeenCalled()
    expect(d.criarIssueNoProduto).not.toHaveBeenCalled()
    expect(runAnaliseCausaDeInfra).not.toHaveBeenCalled()
    expect(runIssuePadraoDeInfra).not.toHaveBeenCalled()
    expect(r.propostas).toEqual([901])
  })

  it('achado "ci-do-cliente" → fluxo antigo intacto (issue no cliente, sem proposta)', async () => {
    const d = deps()
    const r = await processarAchadosDeInfra(d)
    expect(r.issuesNoCliente).toEqual([501])
    expect(d.criarProposta).not.toHaveBeenCalled()
    expect(d.perguntarAoDono).not.toHaveBeenCalled()
    expect(r.propostas).toEqual([])
  })

  it('achado "dependabot-travado" → proposta (as 14 sessões de .github/scripts), não issue no cliente', async () => {
    const d = deps({
      achados: [
        achado({
          classe: 'dependabot-travado',
          identidadeEstavel: 'dependabot:updates',
          paths: ['.github/scripts'],
        }),
      ],
    })
    const r = await processarAchadosDeInfra(d)
    expect(d.criarProposta).toHaveBeenCalledOnce()
    expect(d.criarIssueNoCliente).not.toHaveBeenCalled()
    expect(r.propostas).toEqual([901])
  })

  it('incidente já com issue aberta (proposta anterior) → jaRastreados, não repropõe', async () => {
    const d = deps({
      achados: [achado({ classe: 'automacao', identidadeEstavel: 'wf:77' })],
      incidentesAbertos: async () => [{ identidadeEstavel: 'wf:77', issueNumber: 901 }],
    })
    const r = await processarAchadosDeInfra(d)
    expect(r.jaRastreados).toEqual(['wf:77'])
    expect(d.criarProposta).not.toHaveBeenCalled()
  })

  it('um achado que falha não derruba os outros', async () => {
    const criarIssueNoCliente = vi
      .fn<(f: DoDFields, a: AchadoDeInfra) => Promise<number>>()
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce(502)
    const d = deps({
      achados: [achado({ identidadeEstavel: 'wf:1' }), achado({ identidadeEstavel: 'wf:2' })],
      criarIssueNoCliente,
    })
    const r = await processarAchadosDeInfra(d)
    expect(r.issuesNoCliente).toEqual([502])
  })
})
