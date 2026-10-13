import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  decidirNovaExecucao,
  pedirNovaExecucaoDoCi,
  esquecerPedidosDeNovaExecucao,
} from './nova-execucao-do-ci.js'
import type { ExecucaoDoCi } from './estado-da-verificacao-do-github.js'

const exec = (over: Partial<ExecucaoDoCi> = {}): ExecucaoDoCi => ({
  id: 10,
  status: 'completed',
  conclusion: 'cancelled',
  tentativa: 1,
  ...over,
})

describe('decidirNovaExecucao', () => {
  it('execução cancelada na primeira tentativa: pede reexecução inteira', () => {
    expect(decidirNovaExecucao([exec()], 'sem-resultado')).toEqual({
      acao: 'pedir',
      execucoes: [{ id: 10, rota: 'rerun' }],
    })
  })

  it('várias execuções canceladas (um workflow cada): pede todas, uma vez', () => {
    const d = decidirNovaExecucao([exec({ id: 1 }), exec({ id: 2 })], 'sem-resultado')
    expect(d).toEqual({
      acao: 'pedir',
      execucoes: [
        { id: 1, rota: 'rerun' },
        { id: 2, rota: 'rerun' },
      ],
    })
  })

  it('nenhuma execução no commit: não há o que reexecutar', () => {
    expect(decidirNovaExecucao([], 'sem-resultado')).toEqual({
      acao: 'nada',
      motivo: 'sem-execucao',
    })
  })

  it('o teto é por commit: execução que já está na segunda tentativa trava o pedido', () => {
    expect(decidirNovaExecucao([exec({ tentativa: 2 })], 'sem-resultado')).toEqual({
      acao: 'nada',
      motivo: 'ja-reexecutada',
    })
    // Mesmo que outra execução do mesmo commit ainda esteja na primeira.
    expect(
      decidirNovaExecucao([exec({ id: 1, tentativa: 2 }), exec({ id: 2 })], 'sem-resultado')
    ).toEqual({ acao: 'nada', motivo: 'ja-reexecutada' })
  })

  it('execução obsoleta ou esperando liberação não se reexecuta', () => {
    expect(decidirNovaExecucao([exec({ conclusion: 'action_required' })], 'sem-resultado')).toEqual(
      { acao: 'nada', motivo: 'nada-reexecutavel' }
    )
    expect(decidirNovaExecucao([exec({ conclusion: 'stale' })], 'sem-resultado')).toEqual({
      acao: 'nada',
      motivo: 'nada-reexecutavel',
    })
  })

  it('action_required não gera pedido de nova execução, em nenhum estado', () => {
    for (const estado of ['sem-resultado', 'falha-de-infraestrutura'] as const) {
      const d = decidirNovaExecucao([exec({ conclusion: 'action_required' })], estado)
      expect(d.acao).toBe('nada')
    }
  })

  it('falha de infraestrutura: reexecuta só os jobs que falharam', () => {
    expect(
      decidirNovaExecucao([exec({ conclusion: 'failure' })], 'falha-de-infraestrutura')
    ).toEqual({ acao: 'pedir', execucoes: [{ id: 10, rota: 'rerun-failed-jobs' }] })
  })

  it('falha de infraestrutura com execução cancelada: nada a fazer, o caso é outro', () => {
    expect(
      decidirNovaExecucao([exec({ conclusion: 'cancelled' })], 'falha-de-infraestrutura')
    ).toEqual({ acao: 'nada', motivo: 'nada-reexecutavel' })
  })
})

describe('pedirNovaExecucaoDoCi', () => {
  beforeEach(() => esquecerPedidosDeNovaExecucao())

  const base = () => ({
    repositorio: 'acme/api',
    sha: 'abc123',
    motivo: 'sem-resultado' as const,
    execucoes: [exec({ id: 77 })],
    ghGet: vi.fn(),
    ghEnviar: vi.fn().mockResolvedValue({}),
  })

  it('pede a reexecução da execução cancelada e diz isso em palavras simples', async () => {
    const a = base()
    const r = await pedirNovaExecucaoDoCi(a)
    expect(a.ghEnviar).toHaveBeenCalledTimes(1)
    expect(a.ghEnviar).toHaveBeenCalledWith('POST', '/repos/acme/api/actions/runs/77/rerun')
    expect(r.pedida).toBe(true)
    expect(r.primeiraVez).toBe(true)
    expect(r.texto).toMatch(/nova execução/i)
  })

  it('a segunda passada no mesmo commit NÃO repete o pedido, nem com a execução igual', async () => {
    const a = base()
    await pedirNovaExecucaoDoCi(a)
    const r2 = await pedirNovaExecucaoDoCi(a)
    expect(a.ghEnviar).toHaveBeenCalledTimes(1)
    expect(r2.pedida).toBe(false)
    expect(r2.primeiraVez).toBe(false)
  })

  it('commit novo é outro commit: o pedido vale de novo', async () => {
    const a = base()
    await pedirNovaExecucaoDoCi(a)
    await pedirNovaExecucaoDoCi({ ...a, sha: 'def456' })
    expect(a.ghEnviar).toHaveBeenCalledTimes(2)
  })

  it('sem execução nenhuma: não chama o GitHub e explica', async () => {
    const a = { ...base(), execucoes: [] }
    const r = await pedirNovaExecucaoDoCi(a)
    expect(a.ghEnviar).not.toHaveBeenCalled()
    expect(r.pedida).toBe(false)
    expect(r.texto).toMatch(/nenhuma execução/i)
  })

  it('sem as execuções na mão, lê as do commit uma vez', async () => {
    const ghGet = vi.fn().mockResolvedValue({
      workflow_runs: [{ id: 5, status: 'completed', conclusion: 'cancelled', run_attempt: 1 }],
    })
    const a = { ...base(), execucoes: undefined, ghGet }
    const r = await pedirNovaExecucaoDoCi(a)
    expect(ghGet).toHaveBeenCalledWith('/repos/acme/api/actions/runs?head_sha=abc123&per_page=100')
    expect(a.ghEnviar).toHaveBeenCalledWith('POST', '/repos/acme/api/actions/runs/5/rerun')
    expect(r.pedida).toBe(true)
  })

  it('sem permissão (403): registra o motivo UMA vez e não insiste na passada seguinte', async () => {
    const a = {
      ...base(),
      ghEnviar: vi
        .fn()
        .mockRejectedValue(new Error('GitHub POST /x failed (403): Resource not accessible')),
    }
    const r1 = await pedirNovaExecucaoDoCi(a)
    expect(r1.pedida).toBe(false)
    expect(r1.primeiraVez).toBe(true)
    expect(r1.texto).toMatch(/permiss/i)
    const r2 = await pedirNovaExecucaoDoCi(a)
    expect(a.ghEnviar).toHaveBeenCalledTimes(1)
    expect(r2.primeiraVez).toBe(false)
  })

  it('o nível de autonomia recusou a escrita: também vira "sem permissão", em palavras simples', async () => {
    const erro = Object.assign(new Error('escrita recusada pelo nível'), {
      name: 'EscritaNaoAutorizadaError',
    })
    const a = { ...base(), ghEnviar: vi.fn().mockRejectedValue(erro) }
    const r = await pedirNovaExecucaoDoCi(a)
    expect(r.pedida).toBe(false)
    expect(r.texto).toMatch(/permiss/i)
  })

  it('outro erro do GitHub: registra e não lança', async () => {
    const a = { ...base(), ghEnviar: vi.fn().mockRejectedValue(new Error('GitHub 502')) }
    const r = await pedirNovaExecucaoDoCi(a)
    expect(r.pedida).toBe(false)
    expect(r.texto).toMatch(/não consegui/i)
  })
})
