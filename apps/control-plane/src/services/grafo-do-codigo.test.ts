import { describe, it, expect, vi } from 'vitest'
import {
  garantirGrafoDoRepositorio,
  garantirHistoricoCompletoDoGit,
  consultarGrafoDeCodigo,
  dataDaUltimaAlteracao,
} from './grafo-do-codigo.js'

describe('garantirGrafoDoRepositorio', () => {
  it('reaproveita o graph.json quando já existe — não chama o graphify de novo', async () => {
    const execFileImpl = vi.fn()
    const resultado = await garantirGrafoDoRepositorio('/ws/repo', {
      execFileImpl,
      existsSyncImpl: () => true,
    })
    expect(resultado).toEqual({ ok: true })
    expect(execFileImpl).not.toHaveBeenCalled()
  })

  it('extrai com --code-only (sem LLM) quando o grafo ainda não existe', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const resultado = await garantirGrafoDoRepositorio('/ws/repo', {
      execFileImpl,
      existsSyncImpl: () => false,
      graphifyBin: 'graphify',
    })
    expect(resultado).toEqual({ ok: true })
    expect(execFileImpl).toHaveBeenCalledWith(
      'graphify',
      ['extract', '/ws/repo', '--code-only', '--out', '/ws/repo'],
      expect.objectContaining({ timeout: expect.any(Number), maxBuffer: expect.any(Number) })
    )
  })

  it('devolve ok:false com o motivo REAL quando o graphify falha — nunca finge sucesso', async () => {
    const execFileImpl = vi
      .fn()
      .mockRejectedValue({ stderr: 'graphify: extraction crashed on foo.ts' })
    const resultado = await garantirGrafoDoRepositorio('/ws/repo', {
      execFileImpl,
      existsSyncImpl: () => false,
    })
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.motivo).toContain('extraction crashed on foo.ts')
    }
  })
})

describe('consultarGrafoDeCodigo', () => {
  // "Start: [...]" traz os RÓTULOS que bateram direto com a pergunta
  // (sementes). `RelatorioController` só aparece porque está a 1 salto de
  // `gerarPdf` (BFS depth=2) — não é semente, é vizinho.
  const SAIDA_REAL_DO_GRAPHIFY = [
    "Graph: repo/graphify-out/graph.json (129 nodes) | Traversal: BFS depth=2 | Start: ['exportarRelatorioPdf', 'gerarPdf'] | 3 nodes found",
    '',
    'NODE exportarRelatorioPdf [src=src/relatorios/exportar-pdf.ts loc=L12 community=3]',
    'NODE gerarPdf [src=src/relatorios/exportar-pdf.ts loc=L40 community=3]',
    'NODE RelatorioController [src=src/controllers/relatorio.ts loc=L5 community=1]',
    'EDGE exportarRelatorioPdf --calls [EXTRACTED]--> gerarPdf at=src/relatorios/exportar-pdf.ts:L40',
  ].join('\n')

  it('faz parse das linhas NODE (com src=) devolvidas pelo graphify query real, marcando quem é semente', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: SAIDA_REAL_DO_GRAPHIFY, stderr: '' })
    const resultado = await consultarGrafoDeCodigo('/ws/repo', 'exportar relatorio pdf', {
      execFileImpl,
    })

    expect(resultado.disponivel).toBe(true)
    if (resultado.disponivel) {
      expect(resultado.nos).toEqual([
        { label: 'exportarRelatorioPdf', arquivo: 'src/relatorios/exportar-pdf.ts', semente: true },
        { label: 'gerarPdf', arquivo: 'src/relatorios/exportar-pdf.ts', semente: true },
        { label: 'RelatorioController', arquivo: 'src/controllers/relatorio.ts', semente: false },
      ])
    }
  })

  it('"No matching nodes found." vira lista vazia, não indisponibilidade', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValue({ stdout: 'No matching nodes found.\n', stderr: '' })
    const resultado = await consultarGrafoDeCodigo('/ws/repo', 'termo inexistente', {
      execFileImpl,
    })
    expect(resultado).toEqual({ disponivel: true, bruto: 'No matching nodes found.\n', nos: [] })
  })

  it('devolve disponivel:false com o motivo REAL quando o processo falha — nunca inventa uma resposta', async () => {
    const execFileImpl = vi.fn().mockRejectedValue({ stderr: 'error: graph file not found' })
    const resultado = await consultarGrafoDeCodigo('/ws/repo', 'algo', { execFileImpl })
    expect(resultado.disponivel).toBe(false)
    if (!resultado.disponivel) {
      expect(resultado.motivo).toContain('graph file not found')
    }
  })

  it('passa a pergunta e o budget como argumentos reais do graphify query', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValue({ stdout: 'No matching nodes found.\n', stderr: '' })
    await consultarGrafoDeCodigo('/ws/repo', 'corrigir cadastro de cliente', {
      execFileImpl,
      budget: 500,
    })
    expect(execFileImpl).toHaveBeenCalledWith(
      'graphify',
      [
        'query',
        'corrigir cadastro de cliente',
        '--graph',
        '/ws/repo/graphify-out/graph.json',
        '--budget',
        '500',
      ],
      expect.any(Object)
    )
  })
})

describe('garantirHistoricoCompletoDoGit', () => {
  // O clone real do produto usa `--depth 1` (LocalWorkspaceProvider). Medido
  // ao vivo: num clone assim, `git log -1` devolve a MESMA data (a do clone)
  // pra qualquer arquivo — o sinal de recência do "já resolvido" fica sem
  // sentido sem aprofundar o histórico primeiro.
  it('detecta clone raso e roda git fetch --unshallow', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' }) // rev-parse --is-shallow-repository
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fetch --unshallow
    const resultado = await garantirHistoricoCompletoDoGit('/ws/repo', { execFileImpl })
    expect(resultado).toEqual({ ok: true })
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      'git',
      ['fetch', '--unshallow'],
      expect.objectContaining({ cwd: '/ws/repo' })
    )
  })

  it('não mexe em nada quando o clone já tem histórico completo', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: 'false\n', stderr: '' })
    const resultado = await garantirHistoricoCompletoDoGit('/ws/repo', { execFileImpl })
    expect(resultado).toEqual({ ok: true })
    expect(execFileImpl).toHaveBeenCalledTimes(1) // só o rev-parse, sem fetch
  })

  it('devolve ok:false com o motivo REAL quando o unshallow falha — nunca finge histórico completo', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce({ stderr: 'fatal: unable to unshallow' })
    const resultado = await garantirHistoricoCompletoDoGit('/ws/repo', { execFileImpl })
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.motivo).toContain('unable to unshallow')
    }
  })
})

describe('dataDaUltimaAlteracao', () => {
  it('lê a data ISO da última alteração via git log', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValue({ stdout: '2026-08-20T10:00:00-03:00\n', stderr: '' })
    const t = await dataDaUltimaAlteracao('/ws/repo', 'src/a.ts', execFileImpl)
    expect(t).toBe(Date.parse('2026-08-20T10:00:00-03:00'))
    expect(execFileImpl).toHaveBeenCalledWith(
      'git',
      ['log', '-1', '--format=%cI', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/ws/repo' })
    )
  })

  it('devolve undefined (não lança, não finge data) quando o git falha', async () => {
    const execFileImpl = vi.fn().mockRejectedValue(new Error('not a git repository'))
    const t = await dataDaUltimaAlteracao('/ws/repo', 'src/a.ts', execFileImpl)
    expect(t).toBeUndefined()
  })

  it('devolve undefined quando o arquivo nunca apareceu no histórico (stdout vazio)', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const t = await dataDaUltimaAlteracao('/ws/repo', 'src/nunca-commitado.ts', execFileImpl)
    expect(t).toBeUndefined()
  })
})
