import { describe, it, expect, vi } from 'vitest'
import type { InfraIssueForm } from '@gitorch/cadence'
import {
  PAUSA_ENTRE_ESCRITAS_MS,
  TETO_DE_AJUSTES_POR_MISSAO,
  TETO_DE_LEITURAS_POR_MISSAO,
  rodarAjusteDeTarefasForaDoPadrao,
  type CandidataAoAjuste,
  type DepsDoAjusteDoPo,
} from './ajuste-de-tarefas-do-po.js'
import { hashDoCorpoDaTarefa } from './conferir-tarefa-sem-pedido.js'
import { ErroDoGitHub } from './erro-do-github.js'

const AGORA = new Date('2026-10-08T12:00:00.000Z')
const CORPO = (n: number) => `Texto solto da tarefa ${n}, veja #${n + 1000}.`
const TITULO = (n: number) => `tarefa ${n}`

function candidata(n: number, extra: Record<string, unknown> = {}): CandidataAoAjuste {
  return {
    numero: n,
    conferencia: {
      padraoOk: false,
      erros: ['goal: empty'],
      camposFaltando: ['goal'],
      peso: null,
      estaNoQuadro: true,
      naSprint: false,
      emExecucao: false,
      hashDoCorpo: hashDoCorpoDaTarefa(TITULO(n), CORPO(n)),
      ...extra,
    },
  }
}

function formularioPara(n: number): InfraIssueForm {
  const ref = `#${n + 1000}`
  return {
    fields: {
      titulo: `Tarefa ${n} reescrita`,
      goal: `Objetivo ${ref}`,
      taskDetails: 'detalhes',
      taskDescription: 'descrição',
      implementationGuide: 'passo 1',
      verificationCriteria: '- roda o teste e passa',
      dependencies: 'nenhuma',
      relatedFiles: 'src/x.ts',
      notes: 'notas',
    },
  }
}

function montar(candidatas: CandidataAoAjuste[], sobrescrever: Partial<DepsDoAjusteDoPo> = {}) {
  const escritas: number[] = []
  const motor: number[] = []
  const gravadas: Array<{ numero: number; parcial: Record<string, unknown> }> = []
  const eventos: Array<{ chave: string; texto: string }> = []
  const infos: string[] = []
  const esperas: number[] = []
  const deps: DepsDoAjusteDoPo = {
    repo: 'acme/api',
    autonomia: () => 'cuidar',
    interruptorLigado: () => true,
    lerIssue: vi.fn(async (n: number) => ({
      titulo: TITULO(n),
      corpo: CORPO(n),
      etiquetas: ['gitorch:task'],
      estado: 'open',
      ehPullRequest: false,
      atualizadaEm: new Date(AGORA.getTime() - 72 * 3_600_000),
    })),
    escreverIssue: vi.fn(async (n: number) => {
      escritas.push(n)
    }),
    temSessaoDoDevViva: vi.fn(async () => false),
    temEntregaEmJulgamento: vi.fn(async () => false),
    gravarConferencia: vi.fn(async (numero: number, parcial: Record<string, unknown>) => {
      gravadas.push({ numero, parcial })
    }),
    lerConferencia: vi.fn(async () => null),
    registrarNoPainel: vi.fn(async (e: { chave: string; texto: string }) => {
      eventos.push(e)
    }),
    agora: () => AGORA,
    listarCandidatas: vi.fn(async () => candidatas),
    ajustarComOMotor: vi.fn(async (a: { numero: number }) => {
      motor.push(a.numero)
      return formularioPara(a.numero)
    }),
    esperar: vi.fn(async (ms: number) => {
      esperas.push(ms)
    }),
    freioDeCotaAtivo: () => false,
    info: (m: string) => {
      infos.push(m)
    },
    onWarn: vi.fn(),
    ...sobrescrever,
  }
  return { deps, escritas, motor, gravadas, eventos, infos, esperas }
}

describe('rodarAjusteDeTarefasForaDoPadrao (a missão do PO)', () => {
  it('reescreve a tarefa fora do padrão e para por aí quando só há uma', async () => {
    const m = montar([candidata(10)])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([10])
    expect(m.escritas).toEqual([10])
    expect(m.motor).toEqual([10])
  })

  it('teto de 3 por missão, mesmo com cinco candidatas', async () => {
    expect(TETO_DE_AJUSTES_POR_MISSAO).toBe(3)
    const m = montar([10, 11, 12, 13, 14].map((n) => candidata(n)))
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([10, 11, 12])
    expect(m.escritas).toHaveLength(3)
    expect(m.motor).toHaveLength(3)
  })

  it('escritas em série: nenhuma pausa antes da primeira, 1 s antes de cada seguinte', async () => {
    expect(PAUSA_ENTRE_ESCRITAS_MS).toBeGreaterThanOrEqual(1000)
    const ordem: string[] = []
    const m = montar(
      [10, 11, 12].map((n) => candidata(n)),
      {
        escreverIssue: vi.fn(async (n: number) => {
          ordem.push(`PATCH ${n}`)
        }),
        esperar: vi.fn(async (ms: number) => {
          ordem.push(`ESPERA ${ms}`)
        }),
      }
    )
    await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(ordem).toEqual([
      'PATCH 10',
      `ESPERA ${PAUSA_ENTRE_ESCRITAS_MS}`,
      'PATCH 11',
      `ESPERA ${PAUSA_ENTRE_ESCRITAS_MS}`,
      'PATCH 12',
    ])
  })

  it('prioriza as da sprint e as em execução; o resto vem por número', async () => {
    const m = montar([
      candidata(30),
      candidata(31, { naSprint: true }),
      candidata(32),
      candidata(33, { emExecucao: true }),
      candidata(20),
    ])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([31, 33, 20])
  })

  it('ignora quem já está no padrão', async () => {
    const m = montar([candidata(10, { padraoOk: true }), candidata(11)])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([11])
  })

  it('não repete a mesma tarefa com o mesmo texto: já ajustada, inválida ou desfeita', async () => {
    const h = (n: number) => hashDoCorpoDaTarefa(TITULO(n), CORPO(n))
    const m = montar([
      candidata(10, { ajuste: { estado: 'aplicado', hashDoCorpoOriginal: h(10) } }),
      candidata(11, { ajuste: { estado: 'invalido', hashDoCorpoOriginal: h(11) } }),
      candidata(12, { ajuste: { estado: 'desfeito', hashDoCorpoOriginal: h(12) } }),
      candidata(13, { ajuste: { estado: 'falhou', falhas: 2, hashDoCorpoOriginal: h(13) } }),
      candidata(14),
    ])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([14])
    expect(m.motor).toEqual([14])
  })

  it('tarefa com ajuste incerto no mesmo texto não é tentada de novo às cegas', async () => {
    const h = hashDoCorpoDaTarefa(TITULO(10), CORPO(10))
    const m = montar([
      candidata(10, { ajuste: { estado: 'incerto', hashDoCorpoOriginal: h } }),
      candidata(11),
    ])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([11])
    expect(m.motor).toEqual([11])
  })

  it('PATCH que chegou mas devolveu erro, e a releitura confirma: conta como aplicada e segue a missão', async () => {
    const mundo = new Map<number, { titulo: string; corpo: string }>()
    const m = montar([candidata(10), candidata(11)], {
      lerIssue: vi.fn(async (n: number) => ({
        titulo: mundo.get(n)?.titulo ?? TITULO(n),
        corpo: mundo.get(n)?.corpo ?? CORPO(n),
        etiquetas: ['gitorch:task'],
        estado: 'open',
        ehPullRequest: false,
        atualizadaEm: new Date(AGORA.getTime() - 72 * 3_600_000),
      })),
      escreverIssue: vi.fn(async (n: number, d: { titulo: string; corpo: string }) => {
        mundo.set(n, d)
        if (n === 10) throw new Error('timeout na resposta')
      }),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([10, 11])
    expect(r.falhas).toEqual([])
    expect(m.eventos.filter((e) => e.chave.startsWith('ajuste:acme/api:10:'))).toHaveLength(1)
  })

  it('PATCH incerto (a releitura também cai): registra em "incertas", avisa e para a missão', async () => {
    let quebrado = false
    const m = montar([candidata(10), candidata(11)], {
      lerIssue: vi.fn(async (n: number) => {
        if (quebrado) throw new Error('GET 502')
        return {
          titulo: TITULO(n),
          corpo: CORPO(n),
          etiquetas: ['gitorch:task'],
          estado: 'open',
          ehPullRequest: false,
          atualizadaEm: new Date(AGORA.getTime() - 72 * 3_600_000),
        }
      }),
      escreverIssue: vi.fn(async () => {
        quebrado = true
        throw new Error('timeout na resposta')
      }),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.incertas).toEqual([10])
    expect(r.aplicadas).toEqual([])
    expect(m.motor).toEqual([10])
    expect(m.deps.onWarn).toHaveBeenCalledTimes(1)
  })

  it('o texto mudou desde a tentativa anterior: tenta de novo; uma falha só ainda não fecha a porta', async () => {
    const h = (n: number) => hashDoCorpoDaTarefa(TITULO(n), CORPO(n))
    const m = montar([
      candidata(10, {
        ajuste: { estado: 'invalido', hashDoCorpoOriginal: 'hash-de-um-texto-antigo' },
      }),
      candidata(11, { ajuste: { estado: 'falhou', falhas: 1, hashDoCorpoOriginal: h(11) } }),
    ])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([10, 11])
  })

  it('autonomia diferente de cuidar: não lista, não lê o GitHub, não chama o motor', async () => {
    for (const autonomia of ['so_olhar', 'sugerir', null]) {
      const m = montar([candidata(10)], { autonomia: () => autonomia })
      const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
      expect(r.aplicadas).toEqual([])
      expect(r.puladoPor).toBe('autonomia')
      expect(m.deps.listarCandidatas).not.toHaveBeenCalled()
      expect(m.deps.lerIssue).not.toHaveBeenCalled()
      expect(m.motor).toEqual([])
      expect(m.escritas).toEqual([])
    }
  })

  it('interruptor desligado: nada acontece', async () => {
    const m = montar([candidata(10)], { interruptorLigado: () => false })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.puladoPor).toBe('interruptor')
    expect(m.deps.listarCandidatas).not.toHaveBeenCalled()
    expect(m.motor).toEqual([])
  })

  it('freio de cota ativo: pula com UMA linha de log', async () => {
    const m = montar([candidata(10), candidata(11)], { freioDeCotaAtivo: () => true })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.puladoPor).toBe('freio-de-cota')
    expect(m.infos).toHaveLength(1)
    expect(m.deps.lerIssue).not.toHaveBeenCalled()
  })

  it('trava (sessão do dev viva): pula sem gastar motor e segue para a próxima', async () => {
    const m = montar([candidata(10), candidata(11)], {
      temSessaoDoDevViva: vi.fn(async (n: number) => n === 10),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([11])
    expect(m.motor).toEqual([11])
    expect(r.bloqueadas).toEqual([{ numero: 10, motivo: expect.stringContaining('sessão') }])
  })

  it('editada por gente nas últimas 24 h: pula sem gastar motor', async () => {
    const m = montar([candidata(10)], {
      lerIssue: vi.fn(async (n: number) => ({
        titulo: TITULO(n),
        corpo: CORPO(n),
        etiquetas: [],
        estado: 'open',
        ehPullRequest: false,
        atualizadaEm: new Date(AGORA.getTime() - 3_600_000),
      })),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([])
    expect(m.motor).toEqual([])
    expect(m.escritas).toEqual([])
  })

  it('teto de leituras: as bloqueadas não devoram a missão inteira', async () => {
    const muitas = Array.from({ length: 30 }, (_, i) => candidata(100 + i))
    const m = montar(muitas, {
      lerIssue: vi.fn(async (n: number) => ({
        titulo: TITULO(n),
        corpo: CORPO(n),
        etiquetas: ['jules'],
        estado: 'open',
        ehPullRequest: false,
        atualizadaEm: new Date(AGORA.getTime() - 72 * 3_600_000),
      })),
    })
    await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(m.deps.lerIssue).toHaveBeenCalledTimes(TETO_DE_LEITURAS_POR_MISSAO)
  })

  it('o motor devolve formulário que perde uma referência: nada é escrito e o motivo vai ao painel', async () => {
    const m = montar([candidata(10)], {
      ajustarComOMotor: vi.fn(async () => ({
        fields: { ...formularioPara(10).fields, goal: 'sem a referência' },
      })),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([])
    expect(r.invalidas).toEqual([10])
    expect(m.escritas).toEqual([])
    expect(m.eventos).toHaveLength(1)
  })

  it('o motor respondeu torto (erroDeValidacao): registra a tentativa e não escreve', async () => {
    const m = montar([candidata(10)], {
      ajustarComOMotor: vi.fn(async () => ({ erroDeValidacao: 'json inválido' })),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.invalidas).toEqual([10])
    expect(m.escritas).toEqual([])
    expect(m.gravadas.at(-1)?.parcial).toMatchObject({
      ajuste: { estado: 'invalido', motivo: expect.stringContaining('json inválido') },
    })
  })

  it('falha do motor (não é formulário torto) para a missão e NÃO marca a tarefa como tentada', async () => {
    const m = montar([candidata(10), candidata(11)], {
      ajustarComOMotor: vi.fn(async () => {
        throw new Error('quota exhausted')
      }),
    })
    await expect(rodarAjusteDeTarefasForaDoPadrao(m.deps)).rejects.toThrow('quota exhausted')
    expect(m.gravadas).toEqual([])
    expect(m.escritas).toEqual([])
  })

  it('erro do GitHub com cota estourada na leitura: a missão para e o relato vai adiante', async () => {
    const erro = new ErroDoGitHub('GitHub GET failed (403)', {
      status: 403,
      retryAfterSegundos: 60,
      limiteRestante: 0,
      limiteResetaEmSegundos: null,
    })
    const m = montar([candidata(10), candidata(11)], {
      lerIssue: vi.fn(async () => {
        throw erro
      }),
    })
    await expect(rodarAjusteDeTarefasForaDoPadrao(m.deps)).rejects.toBe(erro)
    expect(m.deps.lerIssue).toHaveBeenCalledTimes(1)
  })

  it('issue apagada ou transferida (404): pula só aquela e segue', async () => {
    const naoAchou = new ErroDoGitHub('GitHub GET failed (404)', {
      status: 404,
      retryAfterSegundos: null,
      limiteRestante: null,
      limiteResetaEmSegundos: null,
    })
    const m = montar([candidata(10), candidata(11)], {
      lerIssue: vi.fn(async (n: number) => {
        if (n === 10) throw naoAchou
        return {
          titulo: TITULO(n),
          corpo: CORPO(n),
          etiquetas: [],
          estado: 'open',
          ehPullRequest: false,
          atualizadaEm: new Date(AGORA.getTime() - 72 * 3_600_000),
        }
      }),
    })
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([11])
  })

  it('sem candidatas, não faz nada', async () => {
    const m = montar([])
    const r = await rodarAjusteDeTarefasForaDoPadrao(m.deps)
    expect(r.aplicadas).toEqual([])
    expect(m.deps.lerIssue).not.toHaveBeenCalled()
  })
})
