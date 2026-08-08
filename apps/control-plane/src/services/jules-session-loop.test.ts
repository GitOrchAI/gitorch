import { describe, it, expect, vi } from 'vitest'
import { decidirRespostaDaSessao, acompanharSessoesDoDev } from './jules-session-loop.js'

// Visto em produção: a delegação abriu a sessão de trabalho e a abandonou.
//
//   SM delegated 1 ready task(s): #36. Dev sessions: #36→sessions/79624...
//   estado da sessão: AWAITING_USER_FEEDBACK
//
// O dev assíncrono tinha feito um trabalho bom — leu os logs da execução que
// falhou, leu os commits recentes, abriu o arquivo do workflow — e terminou
// com uma pergunta técnica precisa. Ninguém respondeu, e a esteira parou ali
// por horas. Criar sessão sem acompanhar é falar sem ouvir.

describe('decidirRespostaDaSessao', () => {
  const contextoDaTask = {
    issueNumber: 36,
    tituloDaIssue: '[Incident] CI failing on main',
    corpoDaIssue:
      '## Verification Criteria\n\n- o número do PR é resolvido nos três formatos de evento',
  }

  it('sessão trabalhando: não interrompe', () => {
    const d = decidirRespostaDaSessao({ estado: 'IN_PROGRESS', ultimaMensagem: '', contextoDaTask })
    expect(d.acao).toBe('aguardar')
  })

  it('sessão pedindo aprovação de plano: aprova sem gastar o motor', () => {
    const d = decidirRespostaDaSessao({
      estado: 'AWAITING_PLAN_APPROVAL',
      ultimaMensagem: 'here is my plan',
      contextoDaTask,
    })
    expect(d.acao).toBe('aprovar-plano')
  })

  it('sessão perguntando algo técnico: responde com o contrato da issue', () => {
    const d = decidirRespostaDaSessao({
      estado: 'AWAITING_USER_FEEDBACK',
      ultimaMensagem: 'Should I also add the workflow_run case? Could you provide guidance?',
      contextoDaTask,
    })
    expect(d.acao).toBe('responder')
    expect(d.contextoParaOMotor).toContain('Verification Criteria')
    expect(d.contextoParaOMotor).toContain('#36')
  })

  it('sessão concluída ou falha: encerra o acompanhamento', () => {
    expect(
      decidirRespostaDaSessao({ estado: 'COMPLETED', ultimaMensagem: '', contextoDaTask }).acao
    ).toBe('encerrar')
    expect(
      decidirRespostaDaSessao({ estado: 'FAILED', ultimaMensagem: '', contextoDaTask }).acao
    ).toBe('encerrar')
  })

  it('estado desconhecido não vira ação às cegas', () => {
    const d = decidirRespostaDaSessao({ estado: 'ALGO_NOVO', ultimaMensagem: '', contextoDaTask })
    expect(d.acao).toBe('aguardar')
  })
})

describe('acompanharSessoesDoDev', () => {
  const sessaoPerguntando = {
    sessionId: 'sessions/1',
    issueNumber: 36,
    estado: 'AWAITING_USER_FEEDBACK',
    ultimaMensagem: 'should I add the workflow_run case?',
  }

  const deps = (over: Record<string, unknown> = {}) => ({
    sessoes: [sessaoPerguntando],
    lerSessao: vi.fn(async () => sessaoPerguntando),
    lerIssue: vi.fn(async () => ({
      number: 36,
      title: '[Incident] CI failing on main',
      body: '## Verification Criteria\n\n- resolve o PR nos três eventos',
    })),
    responder: vi.fn(async () => true),
    aprovarPlano: vi.fn(async () => true),
    pedirAoMotor: vi.fn(async () => 'Yes — add the workflow_run case; criteria unchanged.'),
    onWarn: vi.fn(),
    ...over,
  })

  it('responde a sessão parada usando o motor com o contexto da issue', async () => {
    const d = deps()
    const r = await acompanharSessoesDoDev(d)

    expect(d.pedirAoMotor).toHaveBeenCalledTimes(1)
    expect(d.responder).toHaveBeenCalledWith(
      'sessions/1',
      'Yes — add the workflow_run case; criteria unchanged.'
    )
    expect(r.respondidas).toBe(1)
  })

  it('o motor decide, o sistema entrega — resposta vazia não vira mensagem', async () => {
    const d = deps({ pedirAoMotor: vi.fn(async () => '   ') })
    const r = await acompanharSessoesDoDev(d)

    expect(d.responder).not.toHaveBeenCalled()
    expect(r.respondidas).toBe(0)
    expect(d.onWarn).toHaveBeenCalled()
  })

  it('sessão aguardando plano é aprovada sem chamar o motor', async () => {
    const d = deps({
      sessoes: [{ ...sessaoPerguntando, estado: 'AWAITING_PLAN_APPROVAL' }],
      lerSessao: vi.fn(async () => ({ ...sessaoPerguntando, estado: 'AWAITING_PLAN_APPROVAL' })),
    })
    const r = await acompanharSessoesDoDev(d)

    expect(d.aprovarPlano).toHaveBeenCalledWith('sessions/1')
    expect(d.pedirAoMotor).not.toHaveBeenCalled()
    expect(r.planosAprovados).toBe(1)
  })

  it('falha ao falar com o serviço não derruba o acompanhamento das outras sessões', async () => {
    const d = deps({
      sessoes: [sessaoPerguntando, { ...sessaoPerguntando, sessionId: 'sessions/2' }],
      lerSessao: vi
        .fn()
        .mockRejectedValueOnce(new Error('serviço fora'))
        .mockResolvedValue(sessaoPerguntando),
    })
    const r = await acompanharSessoesDoDev(d)

    expect(r.respondidas).toBe(1)
    expect(d.onWarn).toHaveBeenCalled()
  })
})
