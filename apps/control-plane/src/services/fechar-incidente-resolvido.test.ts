import { describe, it, expect, vi } from 'vitest'
import {
  decidirFechamentoDeIncidente,
  decidirEscalonamento,
  mesmaCausa,
  agruparPorCausa,
  varrerIncidentesResolvidos,
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
