import { describe, it, expect, vi } from 'vitest'
import { validateDoD } from '@gitorch/cadence'
import {
  agruparAlertasPorPacote,
  gerarTarefasDeVulnerabilidade,
  marcaDoPacote,
  montarTarefaDoPacote,
  TETO_DE_TAREFAS_POR_CICLO,
  JANELA_DE_ISSUE_FECHADA_MS,
} from './tarefa-de-vulnerabilidade.js'
import type { AlertaDeSeguranca } from './security-debt-collector.js'

const AGORA = new Date('2026-10-06T12:00:00Z')
let seq = 0
function alerta(parcial: Partial<AlertaDeSeguranca>): AlertaDeSeguranca {
  seq += 1
  return {
    numero: seq,
    severidade: 'high',
    pacote: 'pacote',
    ecossistema: 'npm',
    manifesto: 'pnpm-lock.yaml',
    resumo: 'resumo',
    versaoCorrigida: '1.0.1',
    ghsa: `GHSA-${seq}`,
    url: `https://github.com/dono/repo/security/dependabot/${seq}`,
    criadoEm: '2026-10-01T00:00:00Z',
    escopo: 'runtime',
    ...parcial,
  }
}

function depsBase(alertas: AlertaDeSeguranca[], extra: Record<string, unknown> = {}) {
  let proximo = 100
  return {
    alertas,
    autonomiaDeSeguranca: 'sugerir',
    listarTarefasExistentes: vi.fn().mockResolvedValue([]),
    agora: () => AGORA,
    criarIssue: vi.fn().mockImplementation(async () => ({ numero: proximo++ })),
    ligarFichas: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }
}

describe('agruparAlertasPorPacote', () => {
  it('uma tarefa por PACOTE: alertas do mesmo pacote viram um grupo só', () => {
    const { grupos } = agruparAlertasPorPacote([
      alerta({ pacote: 'sharp' }),
      alerta({ pacote: 'sharp', severidade: 'critical' }),
      alerta({ pacote: 'vite', severidade: 'medium' }),
    ])
    expect(grupos.map((g) => [g.pacote, g.alertas.length])).toEqual([
      ['sharp', 2],
      ['vite', 1],
    ])
    expect(grupos[0]?.pior).toBe('critical')
    expect(grupos[0]?.destino).toBe('sprint-atual')
    expect(grupos[1]?.destino).toBe('backlog')
  })

  it('graves primeiro, mesmo quando chegam depois na lista', () => {
    const { grupos } = agruparAlertasPorPacote([
      alerta({ pacote: 'a-baixo', severidade: 'low' }),
      alerta({ pacote: 'b-medio', severidade: 'medium' }),
      alerta({ pacote: 'c-alto', severidade: 'high' }),
      alerta({ pacote: 'd-critico', severidade: 'critical' }),
    ])
    expect(grupos.map((g) => g.pacote)).toEqual(['d-critico', 'c-alto', 'b-medio', 'a-baixo'])
  })

  it('dev-only sem correção não entra em grupo nenhum e sai com o motivo', () => {
    const devSemCorrecao = alerta({
      pacote: 'ferramenta',
      escopo: 'development',
      versaoCorrigida: null,
      severidade: 'critical',
    })
    const { grupos, semTarefa } = agruparAlertasPorPacote([devSemCorrecao])
    expect(grupos).toEqual([])
    expect(semTarefa).toEqual([{ numero: devSemCorrecao.numero, motivo: expect.any(String) }])
  })
})

describe('montarTarefaDoPacote', () => {
  it('nasce no padrão dos 8 campos, com a marca estável e as etiquetas certas', () => {
    const { grupos } = agruparAlertasPorPacote([
      alerta({ pacote: 'sharp', resumo: 'falha <script> no pacote' }),
    ])
    const grupo = grupos[0]
    if (!grupo) throw new Error('grupo esperado')
    const tarefa = montarTarefaDoPacote(grupo)
    expect(validateDoD(tarefa.campos).ok).toBe(true)
    expect(tarefa.corpo).toContain(`<!-- ${marcaDoPacote('npm', 'sharp')} -->`)
    expect(tarefa.corpo).not.toContain('<script>')
    expect(tarefa.etiquetas).toEqual(
      expect.arrayContaining(['gitorch:task', 'gitorch:seguranca', 'gitorch:agent:sm'])
    )
  })

  it('backlog NÃO leva gitorch:task (o Scrum Master não delega o que é backlog)', () => {
    const { grupos } = agruparAlertasPorPacote([alerta({ pacote: 'vite', severidade: 'low' })])
    const grupo = grupos[0]
    if (!grupo) throw new Error('grupo esperado')
    const tarefa = montarTarefaDoPacote(grupo)
    expect(tarefa.etiquetas).not.toContain('gitorch:task')
    expect(tarefa.etiquetas).toEqual(
      expect.arrayContaining(['gitorch:seguranca', 'gitorch:backlog'])
    )
    expect(validateDoD(tarefa.campos).ok).toBe(true)
  })
})

describe('gerarTarefasDeVulnerabilidade', () => {
  it('cria a tarefa do pacote e liga as fichas dos alertas a ela', async () => {
    const a1 = alerta({ pacote: 'sharp' })
    const a2 = alerta({ pacote: 'sharp' })
    const deps = depsBase([a1, a2])
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).toHaveBeenCalledTimes(1)
    expect(deps.ligarFichas).toHaveBeenCalledWith([a1.numero, a2.numero], 100)
    expect(r.criadas).toEqual([{ pacote: 'sharp', issue: 100, destino: 'sprint-atual' }])
  })

  it('idempotente: não recria quando já há issue aberta com a marca do pacote', async () => {
    const a1 = alerta({ pacote: 'sharp' })
    const deps = depsBase([a1], {
      listarTarefasExistentes: vi
        .fn()
        .mockResolvedValue([
          { numero: 55, corpo: `<!-- ${marcaDoPacote('npm', 'sharp')} -->\n...`, fechadaEm: null },
        ]),
    })
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).not.toHaveBeenCalled()
    expect(deps.ligarFichas).toHaveBeenCalledWith([a1.numero], 55)
    expect(r.jaExistiam).toBe(1)
  })

  it('issue FECHADA recentemente com a marca do pacote + alerta ainda aberto: zero tarefas novas', async () => {
    const a1 = alerta({ pacote: 'sharp', severidade: 'critical' })
    const fechadaHaUmDia = new Date(AGORA.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const deps = depsBase([a1], {
      listarTarefasExistentes: vi.fn().mockResolvedValue([
        {
          numero: 56,
          corpo: `<!-- ${marcaDoPacote('npm', 'sharp')} -->\n...`,
          fechadaEm: fechadaHaUmDia,
        },
      ]),
    })
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).not.toHaveBeenCalled()
    expect(r.criadas).toEqual([])
    expect(r.fechadasRecentemente).toBe(1)
    expect(deps.ligarFichas).toHaveBeenCalledWith([a1.numero], 56)
  })

  it('issue fechada FORA da janela: o alerta ainda aberto volta a virar tarefa', async () => {
    const a1 = alerta({ pacote: 'sharp', severidade: 'critical' })
    const fechadaHaMuito = new Date(
      AGORA.getTime() - JANELA_DE_ISSUE_FECHADA_MS - 60_000
    ).toISOString()
    const deps = depsBase([a1], {
      listarTarefasExistentes: vi.fn().mockResolvedValue([
        {
          numero: 57,
          corpo: `<!-- ${marcaDoPacote('npm', 'sharp')} -->`,
          fechadaEm: fechadaHaMuito,
        },
      ]),
    })
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).toHaveBeenCalledTimes(1)
    expect(r.fechadasRecentemente).toBe(0)
  })

  it(`teto: no máximo ${TETO_DE_TAREFAS_POR_CICLO} tarefas novas por ciclo, graves primeiro`, async () => {
    const alertas = [
      alerta({ pacote: 'baixo-1', severidade: 'low' }),
      alerta({ pacote: 'medio-1', severidade: 'medium' }),
      alerta({ pacote: 'alto-1', severidade: 'high' }),
      alerta({ pacote: 'critico-1', severidade: 'critical' }),
      alerta({ pacote: 'alto-2', severidade: 'high' }),
    ]
    const deps = depsBase(alertas)
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).toHaveBeenCalledTimes(TETO_DE_TAREFAS_POR_CICLO)
    expect(r.criadas.map((c) => c.pacote)).toEqual(['critico-1', 'alto-1', 'alto-2'])
    expect(r.adiadas).toBe(2)
  })

  it('projeto SEM configuração de autonomia de segurança não recebe nenhuma tarefa', async () => {
    const alertas = Array.from({ length: 30 }, (_, i) =>
      alerta({ pacote: `p${i}`, severidade: 'critical' })
    )
    for (const nivel of [null, undefined, 'so_olhar', 'valor-desconhecido']) {
      const deps = depsBase(alertas, { autonomiaDeSeguranca: nivel })
      const r = await gerarTarefasDeVulnerabilidade(deps)
      expect(deps.criarIssue).not.toHaveBeenCalled()
      expect(deps.listarTarefasExistentes).not.toHaveBeenCalled()
      expect(r.autorizado).toBe(false)
      expect(r.motivo).toMatch(/Sugerir/)
    }
  })

  it('falha ao listar as tarefas existentes: não cria nada (sem como garantir que não duplica)', async () => {
    const deps = depsBase([alerta({ pacote: 'sharp' })], {
      listarTarefasExistentes: vi.fn().mockRejectedValue(new Error('GitHub fora')),
    })
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).not.toHaveBeenCalled()
    expect(r.falhas).toBe(1)
  })

  it('falha ao criar uma tarefa conta como falha e gasta a vaga do ciclo (sem tempestade de tentativas)', async () => {
    const deps = depsBase(
      [
        alerta({ pacote: 'a', severidade: 'critical' }),
        alerta({ pacote: 'b', severidade: 'critical' }),
        alerta({ pacote: 'c', severidade: 'critical' }),
        alerta({ pacote: 'd', severidade: 'critical' }),
      ],
      { criarIssue: vi.fn().mockRejectedValue(new Error('403')) }
    )
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).toHaveBeenCalledTimes(TETO_DE_TAREFAS_POR_CICLO)
    expect(r.falhas).toBe(TETO_DE_TAREFAS_POR_CICLO)
    expect(r.criadas).toEqual([])
  })

  it('dev-only sem correção nunca vira tarefa, e é contado como "sem tarefa"', async () => {
    const deps = depsBase([
      alerta({ pacote: 'eslint', escopo: 'development', versaoCorrigida: null }),
    ])
    const r = await gerarTarefasDeVulnerabilidade(deps)
    expect(deps.criarIssue).not.toHaveBeenCalled()
    expect(r.semTarefa).toBe(1)
  })
})
