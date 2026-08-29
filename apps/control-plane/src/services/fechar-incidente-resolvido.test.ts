import { describe, it, expect, vi } from 'vitest'
import {
  decidirFechamentoDeIncidente,
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
})
