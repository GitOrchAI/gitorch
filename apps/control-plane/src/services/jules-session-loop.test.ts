import { describe, it, expect } from 'vitest'
import { decidirRespostaDaSessao, PARADO_MS, MAX_NUDGES } from './jules-session-loop.js'

const contextoDaTask = {
  issueNumber: 24,
  tituloDaIssue: 'CI quebrado na main',
  corpoDaIssue: '## Verification Criteria\n\n- o pipeline fica verde',
}

const base = {
  ultimaMensagem: '',
  contextoDaTask,
  temPr: false,
  paradoHaMs: 0,
  nudges: 0,
}

describe('decidirRespostaDaSessao', () => {
  it('concluída COM PR vai para julgamento: é o entregável que o QA existe para avaliar', () => {
    expect(decidirRespostaDaSessao({ ...base, estado: 'COMPLETED', temPr: true }).acao).toBe(
      'julgar'
    )
  })

  it('concluída SEM entrega → fechar-terminal (a linha fecha, a issue volta à fila — D51)', () => {
    // Até 29/08 isto ia para 'investigar', que acionava o SM em loop e NUNCA
    // fechava a linha — a vaga ficava presa para sempre (21 de 23 sessões
    // assim). Agora fecha e a esteira redelega.
    expect(decidirRespostaDaSessao({ ...base, estado: 'COMPLETED' }).acao).toBe('fechar-terminal')
  })

  it('falhou → fechar-terminal (não retoma por mensagem — fecha e redelega)', () => {
    expect(decidirRespostaDaSessao({ ...base, estado: 'FAILED' }).acao).toBe('fechar-terminal')
    expect(decidirRespostaDaSessao({ ...base, estado: 'CANCELLED' }).acao).toBe('fechar-terminal')
  })

  it('esperando aprovação de plano: o sistema aprova, sem gastar motor', () => {
    // O contrato do trabalho já está na issue e foi ele que autorizou a
    // delegação. Gastar o motor aqui seria pagar duas vezes pela mesma decisão.
    expect(decidirRespostaDaSessao({ ...base, estado: 'AWAITING_PLAN_APPROVAL' }).acao).toBe(
      'aprovar-plano'
    )
  })

  it('perguntou algo: responde, e o contexto leva o contrato da task junto', () => {
    const d = decidirRespostaDaSessao({
      ...base,
      estado: 'AWAITING_USER_FEEDBACK',
      ultimaMensagem: 'devo mexer no arquivo de workflow?',
    })

    expect(d.acao).toBe('responder')
    expect(d.contextoParaOMotor).toContain('devo mexer no arquivo de workflow?')
    expect(d.contextoParaOMotor).toContain('Verification Criteria')
  })

  it('pausada pede para continuar: não existe método de retomada na API', () => {
    expect(decidirRespostaDaSessao({ ...base, estado: 'PAUSED' }).acao).toBe('insistir')
  })

  it('trabalhando há muito tempo sem avançar também pede para continuar', () => {
    const d = decidirRespostaDaSessao({ ...base, estado: 'IN_PROGRESS', paradoHaMs: PARADO_MS })
    expect(d.acao).toBe('insistir')
  })

  it('trabalhando há pouco tempo aguarda, para não atrapalhar quem está produzindo', () => {
    const d = decidirRespostaDaSessao({ ...base, estado: 'IN_PROGRESS', paradoHaMs: 60_000 })
    expect(d.acao).toBe('aguardar')
  })

  it('na fila ou planejando há muito tempo também conta como parada', () => {
    for (const estado of ['QUEUED', 'PLANNING']) {
      const d = decidirRespostaDaSessao({ ...base, estado, paradoHaMs: PARADO_MS })
      expect(d.acao).toBe('insistir')
    }
  })

  it('insistir tem teto: estourado, abandona em vez de girar para sempre gastando cota', () => {
    const d = decidirRespostaDaSessao({ ...base, estado: 'PAUSED', nudges: MAX_NUDGES })
    expect(d.acao).toBe('abandonar')
  })

  it('estado desconhecido aguarda: agir às cegas sobre estado novo é pior que esperar', () => {
    expect(decidirRespostaDaSessao({ ...base, estado: 'ALGO_QUE_AINDA_NAO_EXISTE' }).acao).toBe(
      'aguardar'
    )
  })

  it('estado chega em minúsculas e a decisão é a mesma', () => {
    expect(decidirRespostaDaSessao({ ...base, estado: 'completed', temPr: true }).acao).toBe(
      'julgar'
    )
  })
})
