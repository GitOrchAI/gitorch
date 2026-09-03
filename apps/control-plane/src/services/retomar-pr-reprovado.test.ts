import { describe, it, expect, vi } from 'vitest'
import {
  decidirRetomadaDoPr,
  montarPromptDeRetomada,
  retomarPrReprovado,
  TETO_DE_RETOMADAS_POR_PR,
  type DepsDeRetomadaDoPr,
} from './retomar-pr-reprovado.js'

// L4-T5 — issue #3884 do Jardim: 5 sessões e 3 PRs (#3907, #3913, #3917) para
// UMA task. Quando o QA reprova e a sessão do dev já está terminal, a
// retomada certa é uma sessão NOVA na MESMA branch do PR reprovado
// (`startingBranch`/`workingBranch`) — nunca uma sessão que abre um segundo
// PR do zero.

describe('decidirRetomadaDoPr', () => {
  it('abaixo do teto → retomar', () => {
    expect(decidirRetomadaDoPr({ retomadasAnteriores: 0 })).toEqual({ acao: 'retomar' })
    expect(decidirRetomadaDoPr({ retomadasAnteriores: TETO_DE_RETOMADAS_POR_PR - 1 })).toEqual({
      acao: 'retomar',
    })
  })

  it('teto batido → escalar', () => {
    expect(decidirRetomadaDoPr({ retomadasAnteriores: TETO_DE_RETOMADAS_POR_PR })).toEqual({
      acao: 'escalar',
    })
    expect(decidirRetomadaDoPr({ retomadasAnteriores: TETO_DE_RETOMADAS_POR_PR + 5 })).toEqual({
      acao: 'escalar',
    })
  })
})

describe('montarPromptDeRetomada', () => {
  it('leva o parecer do QA e a instrução de não abrir outro PR', () => {
    const prompt = montarPromptDeRetomada({
      numeroDoPr: 3917,
      parecerDoQa: 'O teste X está quebrando porque Y.',
    })
    expect(prompt).toContain('O teste X está quebrando porque Y.')
    expect(prompt).toContain('#3917')
    expect(prompt).toMatch(/N[ÃA]O abra outro pull request/i)
  })
})

function baseArgs() {
  return {
    projectId: 'proj-1',
    repository: 'loureng/patinhas-3d-crafts',
    issueNumber: 3884,
    pr: { number: 3917, headRef: 'jules-3917-branch' },
    parecerDoQa: 'Corrija o teste de checkout que está quebrando.',
    sessaoAnterior: { sessionName: 'sessions/velha' },
  }
}

function depsFake(over: Partial<DepsDeRetomadaDoPr> = {}) {
  const criarSessaoDev = vi.fn(
    async (_args: {
      repository: string
      startingBranch: string
      workingBranch: string
      titulo: string
      prompt: string
    }) => ({
      situacao: 'criada' as const,
      sessionName: 'sessions/nova',
    })
  )
  const registrarSessaoRetomada = vi.fn(async () => undefined)
  const perguntarAoDono = vi.fn(async () => undefined)
  const contarRetomadasAnteriores = vi.fn(async () => 0)
  const deps: DepsDeRetomadaDoPr = {
    contarRetomadasAnteriores,
    criarSessaoDev,
    registrarSessaoRetomada,
    perguntarAoDono,
    onWarn: () => undefined,
    onInfo: () => undefined,
    ...over,
  }
  return {
    deps,
    criarSessaoDev,
    registrarSessaoRetomada,
    perguntarAoDono,
    contarRetomadasAnteriores,
  }
}

describe('retomarPrReprovado', () => {
  it('abre sessão nova com startingBranch/workingBranch = branch do PR reprovado', async () => {
    const { deps, criarSessaoDev } = depsFake()
    const r = await retomarPrReprovado(baseArgs(), deps)
    expect(criarSessaoDev).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'loureng/patinhas-3d-crafts',
        startingBranch: 'jules-3917-branch',
        workingBranch: 'jules-3917-branch',
      })
    )
    expect(r).toEqual({ acao: 'retomou', sessionName: 'sessions/nova' })
  })

  it('o prompt enviado ao dev leva o parecer do QA', async () => {
    const { deps, criarSessaoDev } = depsFake()
    await retomarPrReprovado(baseArgs(), deps)
    const chamada = criarSessaoDev.mock.calls[0]![0] as { prompt: string }
    expect(chamada.prompt).toContain('Corrija o teste de checkout que está quebrando.')
  })

  it('grava a sessão nova com o MESMO número de PR e a MESMA issue', async () => {
    const { deps, registrarSessaoRetomada } = depsFake()
    await retomarPrReprovado(baseArgs(), deps)
    expect(registrarSessaoRetomada).toHaveBeenCalledWith({
      issueNumber: 3884,
      sessionName: 'sessions/nova',
      prNumber: 3917,
    })
  })

  it('dev recusa (falhou) → não grava sessão, devolve o motivo', async () => {
    const { deps, registrarSessaoRetomada } = depsFake({
      criarSessaoDev: vi.fn(async () => ({ situacao: 'falhou' as const, motivo: 'sem vaga' })),
    })
    const r = await retomarPrReprovado(baseArgs(), deps)
    expect(r).toEqual({ acao: 'nao-retomou', motivo: 'sem vaga' })
    expect(registrarSessaoRetomada).not.toHaveBeenCalled()
  })

  it('recurso desligado → não grava sessão, devolve nao-retomou', async () => {
    const { deps } = depsFake({
      criarSessaoDev: vi.fn(async () => ({ situacao: 'desligado' as const })),
    })
    const r = await retomarPrReprovado(baseArgs(), deps)
    expect(r.acao).toBe('nao-retomou')
  })

  it('teto de retomadas já batido → escala ao dono, NUNCA abre sessão', async () => {
    const { deps, criarSessaoDev, perguntarAoDono, registrarSessaoRetomada } = depsFake({
      contarRetomadasAnteriores: vi.fn(async () => TETO_DE_RETOMADAS_POR_PR),
    })
    const r = await retomarPrReprovado(baseArgs(), deps)
    expect(criarSessaoDev).not.toHaveBeenCalled()
    expect(registrarSessaoRetomada).not.toHaveBeenCalled()
    expect(perguntarAoDono).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 3884,
        numeroDoPr: 3917,
        retomadasAnteriores: TETO_DE_RETOMADAS_POR_PR,
      })
    )
    expect(r).toEqual({ acao: 'escalou' })
  })

  it('conta as retomadas pelo NÚMERO DO PR passado, não por um total fixo', async () => {
    const { deps, contarRetomadasAnteriores } = depsFake()
    await retomarPrReprovado(baseArgs(), deps)
    expect(contarRetomadasAnteriores).toHaveBeenCalledWith({
      projectId: 'proj-1',
      prNumber: 3917,
    })
  })
})
