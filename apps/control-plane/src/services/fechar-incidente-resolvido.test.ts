import { describe, it, expect, vi } from 'vitest'
import {
  decidirFechamentoDeIncidente,
  decidirEscalonamento,
  mesmaCausa,
  agruparPorCausa,
  varrerIncidentesResolvidos,
  normalizarNomeDeWorkflow,
  nomeDoWorkflowNaIdentidadeLegada,
  houveRunConcluidaDesde,
  comentarFechamentoDeIncidente,
  type IncidenteAberto,
} from './fechar-incidente-resolvido.js'

function inc(over: Partial<IncidenteAberto> = {}): IncidenteAberto {
  return {
    id: 'i1',
    projectId: 'p1',
    classe: 'ci-do-cliente',
    identidadeEstavel: 'wf:11',
    issueNumber: 50,
    prNumber: 90,
    clearedAt: null,
    firstSeenAt: new Date('2025-12-01T00:00:00.000Z'),
    ...over,
  }
}

describe('decidirFechamentoDeIncidente', () => {
  it('última run verde depois do conserto → fecha issue + limpa incidente', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: true,
      rodouDepoisDoPr: true,
      prMesclado: true,
    })
    expect(d).toMatchObject({ fecharIssue: true, limparIncidente: true })
  })

  it('PR mesclado mas a run ainda não rodou → não fecha', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: true,
    })
    expect(d).toMatchObject({ fecharIssue: false, limparIncidente: false })
  })

  it('nada mudou → ambos false', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: false,
    })
    expect(d).toMatchObject({ fecharIssue: false, limparIncidente: false })
  })

  it('run verde mas ANTES do PR (run velha) → não fecha', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: true,
      rodouDepoisDoPr: false,
      prMesclado: false,
    })
    expect(d.limparIncidente).toBe(false)
  })

  it('incidente do Dependabot: PR mesclado basta (não há run de workflow)', () => {
    const d = decidirFechamentoDeIncidente(inc({ identidadeEstavel: 'dependabot:updates' }), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: true,
    })
    expect(d).toMatchObject({ fecharIssue: true, limparIncidente: true })
  })

  it('já limpo → não faz nada', () => {
    const d = decidirFechamentoDeIncidente(inc({ clearedAt: new Date() }), {
      ultimaRunVerde: true,
      rodouDepoisDoPr: true,
      prMesclado: true,
    })
    expect(d.limparIncidente).toBe(false)
  })

  // L4-T1: o workflow que causava o incidente foi removido do repositório —
  // não existe mais "run" nenhuma para provar verde, e insistir esperando uma
  // deixaria o incidente aberto para sempre. A ausência do workflow É a prova.
  it('workflow removido do repositório → fecha mesmo sem run verde', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: false,
      workflowExiste: false,
    })
    expect(d).toMatchObject({
      fecharIssue: true,
      limparIncidente: true,
      motivo: 'workflow removido do repositório',
    })
  })

  it('já limpo tem prioridade mesmo com o workflow removido', () => {
    const d = decidirFechamentoDeIncidente(inc({ clearedAt: new Date() }), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: false,
      workflowExiste: false,
    })
    expect(d.limparIncidente).toBe(false)
  })

  // L4-T1 (fix-up crítico): PR mesclado às 14h, o workflow AINDA NÃO RODOU
  // desde então — "nenhuma run" não pode virar "nenhuma falha". Sem isso, o
  // workflow roda às 15h e falha com o incidente já fechado. Tem que ficar
  // "aguardando", nunca fechar, enquanto `rodouDepoisDoPr` for false.
  it('PR mesclado, workflow AINDA NÃO rodou desde o merge → não fecha mesmo com houveFalhaDesdeOPr false', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: true,
      houveFalhaDesdeOPr: false,
    })
    expect(d).toMatchObject({
      fecharIssue: false,
      limparIncidente: false,
      motivo: 'PR mesclado, esperando a próxima run do workflow',
    })
  })

  // L4-T1: caso real (#3681, jules-api-retry.yml) — o workflow só tem runs
  // "skipped" desde o conserto, nunca "success", então `ultimaRunVerde` nunca
  // fica true. A prova de que sarou não é "ficou verde", é "não falhou mais"
  // — mas só conta depois que o workflow de fato rodou de novo (skipped já
  // é "rodou").
  it('PR mesclado, HOUVE run depois do PR (mesmo só skipped) e nenhuma falha → fecha', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: true,
      prMesclado: true,
      houveFalhaDesdeOPr: false,
    })
    expect(d).toMatchObject({
      fecharIssue: true,
      limparIncidente: true,
      motivo: 'sem falha do workflow desde a correção',
    })
  })

  it('PR mesclado mas HOUVE falha depois → não fecha por essa via, continua esperando', () => {
    const d = decidirFechamentoDeIncidente(inc(), {
      ultimaRunVerde: false,
      rodouDepoisDoPr: false,
      prMesclado: true,
      houveFalhaDesdeOPr: true,
    })
    expect(d).toMatchObject({ fecharIssue: false, limparIncidente: false })
  })
})

describe('normalizarNomeDeWorkflow', () => {
  it('baixa a caixa e colapsa espaços repetidos', () => {
    expect(normalizarNomeDeWorkflow('Jules   API Retry')).toBe('jules api retry')
  })
  it('remove acentos', () => {
    expect(normalizarNomeDeWorkflow('Ação Rápida')).toBe('acao rapida')
  })
  it('ignora pontuação e espaços nas bordas', () => {
    expect(normalizarNomeDeWorkflow('  CI: Build & Test  ')).toBe('ci build test')
  })
})

describe('nomeDoWorkflowNaIdentidadeLegada', () => {
  it('extrai o nome antes do travessão da identidade legada ci:<nome>', () => {
    expect(nomeDoWorkflowNaIdentidadeLegada('ci:Jules API Retry — re-dispara via API direta')).toBe(
      'Jules API Retry'
    )
  })
  it('identidade ci: sem travessão devolve o nome inteiro', () => {
    expect(nomeDoWorkflowNaIdentidadeLegada('ci:Build')).toBe('Build')
  })
  it('identidade não-ci (wf:/dependabot:) devolve null — não é uma identidade legada', () => {
    expect(nomeDoWorkflowNaIdentidadeLegada('wf:11')).toBeNull()
    expect(nomeDoWorkflowNaIdentidadeLegada('dependabot:updates')).toBeNull()
  })
})

describe('houveRunConcluidaDesde', () => {
  // L4-T1 (fix-up): esta é a regra que decide `rodouDepoisDoPr` no scheduler.
  // Caso real #3681: desde 13/08 o workflow só dispara runs "skipped" — isso
  // TEM que contar como "rodou", senão o incidente nunca fecha por essa via.
  it('run "skipped" depois do corte conta como rodou', () => {
    expect(
      houveRunConcluidaDesde(
        [{ conclusion: 'skipped', run_started_at: '2026-08-13T10:00:00.000Z' }],
        '2026-08-13T09:00:00.000Z'
      )
    ).toBe(true)
  })

  it('run "cancelled" depois do corte também conta', () => {
    expect(
      houveRunConcluidaDesde(
        [{ conclusion: 'cancelled', run_started_at: '2026-08-13T10:00:00.000Z' }],
        '2026-08-13T09:00:00.000Z'
      )
    ).toBe(true)
  })

  it('run ainda em andamento (conclusion nulo) NÃO conta como concluída', () => {
    expect(
      houveRunConcluidaDesde(
        [{ conclusion: null, run_started_at: '2026-08-13T10:00:00.000Z' }],
        '2026-08-13T09:00:00.000Z'
      )
    ).toBe(false)
  })

  it('run concluída ANTES do corte não conta', () => {
    expect(
      houveRunConcluidaDesde(
        [{ conclusion: 'success', run_started_at: '2026-08-13T08:00:00.000Z' }],
        '2026-08-13T09:00:00.000Z'
      )
    ).toBe(false)
  })

  it('lista vazia → false', () => {
    expect(houveRunConcluidaDesde([], '2026-08-13T09:00:00.000Z')).toBe(false)
  })

  it('usa created_at quando run_started_at não vem', () => {
    expect(
      houveRunConcluidaDesde(
        [{ conclusion: 'success', created_at: '2026-08-13T10:00:00.000Z' }],
        '2026-08-13T09:00:00.000Z'
      )
    ).toBe(true)
  })
})

describe('mesmaCausa / agruparPorCausa', () => {
  it('mesmo path + mesma assinatura de erro → mesma causa', () => {
    expect(
      mesmaCausa(
        {
          identidadeEstavel: 'wf:1',
          paths: ['.github/workflows/dep.yml'],
          assinaturaDeErro: 'npm ci failed',
        },
        {
          identidadeEstavel: 'wf:2',
          paths: ['.github/workflows/dep.yml'],
          assinaturaDeErro: 'npm ci failed',
        }
      )
    ).toBe(true)
  })

  it('paths diferentes → causas diferentes', () => {
    expect(
      mesmaCausa(
        { identidadeEstavel: 'wf:1', paths: ['.github/workflows/a.yml'] },
        { identidadeEstavel: 'wf:2', paths: ['.github/workflows/b.yml'] }
      )
    ).toBe(false)
  })

  it('agruparPorCausa: 2 achados da mesma causa → 1 identidade canônica', () => {
    const canon = agruparPorCausa([
      { identidadeEstavel: 'wf:1', paths: ['.github/workflows/dep.yml'], assinaturaDeErro: 'x' },
      { identidadeEstavel: 'wf:2', paths: ['.github/workflows/dep.yml'], assinaturaDeErro: 'x' },
      { identidadeEstavel: 'wf:9', paths: ['.github/workflows/other.yml'] },
    ])
    expect(canon.get('wf:1')).toBe(canon.get('wf:2'))
    expect(canon.get('wf:9')).not.toBe(canon.get('wf:1'))
  })
})

describe('varrerIncidentesResolvidos', () => {
  it('incidente com issue+PR e run verde → fecha issue + limpa', async () => {
    const fecharIssue = vi.fn(async () => undefined)
    const limparIncidente = vi.fn(async () => undefined)
    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc()],
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: true,
        rodouDepoisDoPr: true,
        prMesclado: true,
      }),
      fecharIssue,
      limparIncidente,
    })
    expect(r.fechados).toEqual(['wf:11'])
    expect(fecharIssue).toHaveBeenCalledWith(50, expect.stringContaining('resolvido'))
    expect(limparIncidente).toHaveBeenCalledWith('i1')
  })

  it('incidente ainda quebrado → não fecha, conta como aberto', async () => {
    const fecharIssue = vi.fn(async () => undefined)
    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc()],
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: false,
        rodouDepoisDoPr: false,
        prMesclado: false,
      }),
      fecharIssue,
      limparIncidente: vi.fn(async () => undefined),
    })
    expect(r.fechados).toEqual([])
    expect(r.aindaAbertos).toBe(1)
    expect(fecharIssue).not.toHaveBeenCalled()
  })

  it('um incidente que falha não derruba os outros', async () => {
    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () => [
        inc({ id: 'a', identidadeEstavel: 'wf:1' }),
        inc({ id: 'b', identidadeEstavel: 'wf:2' }),
      ],
      situacaoDoIncidente: async (i) => {
        if (i.id === 'a') throw new Error('gh 500')
        return { ultimaRunVerde: true, rodouDepoisDoPr: true, prMesclado: true }
      },
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
    })
    expect(r.fechados).toEqual(['wf:2'])
    expect(r.aindaAbertos).toBe(1)
  })

  it('incidente sem prNumber → descobre o PR da sessão ANTES de decidir', async () => {
    // O elo que faltava: sem esta ligação, situacaoDoIncidente enxerga
    // prNumber:null para sempre e T9/T10 ficam inertes.
    const descobrirPrDoIncidente = vi.fn(async () => 500)
    let incVisto: IncidenteAberto | undefined
    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc({ prNumber: null })],
      descobrirPrDoIncidente,
      situacaoDoIncidente: async (i) => {
        incVisto = i
        return { ultimaRunVerde: true, rodouDepoisDoPr: true, prMesclado: true }
      },
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
    })
    expect(descobrirPrDoIncidente).toHaveBeenCalledOnce()
    // situacaoDoIncidente recebe o incidente JÁ com o PR ligado.
    expect(incVisto).toMatchObject({ prNumber: 500 })
    expect(r.fechados).toEqual(['wf:11'])
  })

  it('incidente que JÁ tem prNumber → nem chama descobrirPrDoIncidente', async () => {
    const descobrirPrDoIncidente = vi.fn(async () => 999)
    await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc({ prNumber: 90 })],
      descobrirPrDoIncidente,
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: false,
        rodouDepoisDoPr: false,
        prMesclado: false,
      }),
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
    })
    expect(descobrirPrDoIncidente).not.toHaveBeenCalled()
  })

  it('descobrirPrDoIncidente que falha → não derruba a varredura', async () => {
    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc({ prNumber: null })],
      descobrirPrDoIncidente: async () => {
        throw new Error('db timeout')
      },
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: false,
        rodouDepoisDoPr: false,
        prMesclado: false,
      }),
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
    })
    expect(r.aindaAbertos).toBe(1)
  })

  it('resolvido → registrarResolucao com a classe', async () => {
    const registrarResolucao = vi.fn(async () => undefined)
    await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc({ classe: 'ci-do-cliente' })],
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: true,
        rodouDepoisDoPr: true,
        prMesclado: true,
      }),
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
      registrarResolucao,
    })
    expect(registrarResolucao).toHaveBeenCalledWith(
      expect.objectContaining({ classe: 'ci-do-cliente', identidadeEstavel: 'wf:11' })
    )
  })
})

describe('decidirEscalonamento (ESTEIRA-T10)', () => {
  const base = { clearedAt: null, escalatedAt: null }
  it('1º PR fracassado → conta, não escala', () => {
    expect(decidirEscalonamento({ ...base, prAttempts: 0 }, true)).toMatchObject({
      incrementarTentativa: true,
      escalar: false,
    })
  })
  it('3º PR fracassado → conta e ESCALA', () => {
    expect(decidirEscalonamento({ ...base, prAttempts: 2 }, true)).toMatchObject({
      incrementarTentativa: true,
      escalar: true,
    })
  })
  it('PR ainda vivo → nada', () => {
    expect(decidirEscalonamento({ ...base, prAttempts: 2 }, false)).toMatchObject({
      incrementarTentativa: false,
      escalar: false,
    })
  })
  it('já escalado → não re-escala', () => {
    expect(
      decidirEscalonamento({ clearedAt: null, escalatedAt: new Date(), prAttempts: 5 }, true)
    ).toMatchObject({ incrementarTentativa: false, escalar: false })
  })
})

describe('varrerIncidentesResolvidos: escalonamento', () => {
  it('3º PR fechado sem merge → incrementa e escala 1x', async () => {
    const incrementarTentativa = vi.fn(async () => undefined)
    const escalar = vi.fn(async () => undefined)
    const r = await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc({ prAttempts: 2, escalatedAt: null })],
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: false,
        rodouDepoisDoPr: false,
        prMesclado: false,
        prFechadoSemMerge: true,
      }),
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
      incrementarTentativa,
      escalar,
    })
    expect(incrementarTentativa).toHaveBeenCalledWith('i1')
    expect(escalar).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', issueNumber: 50 }))
    expect(r.escalados).toEqual(['wf:11'])
  })

  it('PR vivo → não conta tentativa', async () => {
    const incrementarTentativa = vi.fn(async () => undefined)
    await varrerIncidentesResolvidos({
      listarAbertos: async () => [inc({ prAttempts: 2 })],
      situacaoDoIncidente: async () => ({
        ultimaRunVerde: false,
        rodouDepoisDoPr: false,
        prMesclado: false,
        prFechadoSemMerge: false,
      }),
      fecharIssue: vi.fn(async () => undefined),
      limparIncidente: vi.fn(async () => undefined),
      incrementarTentativa,
      escalar: vi.fn(async () => undefined),
    })
    expect(incrementarTentativa).not.toHaveBeenCalled()
  })
})

describe('comentarFechamentoDeIncidente (L4-T1b: comentário passa pela guarda)', () => {
  it('usa o postarComentario INJETADO (nunca fetch global) para gravar o comentário', async () => {
    const postarComentario = vi.fn(async () => undefined)
    await comentarFechamentoDeIncidente('acme/repo', 42, 'resolvido, fechado sozinho', {
      postarComentario,
    })
    expect(postarComentario).toHaveBeenCalledWith('/repos/acme/repo/issues/42/comments', {
      body: 'resolvido, fechado sozinho',
    })
  })

  it('postarComentario rejeitado → chama onWarn com contexto (repo/issue), NUNCA engole em silêncio', async () => {
    const onWarn = vi.fn()
    const postarComentario = vi.fn(async () => {
      throw new Error('GitHub POST → 403')
    })
    await expect(
      comentarFechamentoDeIncidente('acme/repo', 42, 'resolvido', { postarComentario, onWarn })
    ).resolves.toBeUndefined()
    expect(onWarn).toHaveBeenCalledTimes(1)
    const [mensagem] = onWarn.mock.calls[0] as [string]
    expect(mensagem).toContain('acme/repo')
    expect(mensagem).toContain('42')
    expect(mensagem).toContain('403')
  })

  it('sem onWarn (opcional) → não explode ao falhar', async () => {
    const postarComentario = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(
      comentarFechamentoDeIncidente('acme/repo', 1, 'x', { postarComentario })
    ).resolves.toBeUndefined()
  })
})
