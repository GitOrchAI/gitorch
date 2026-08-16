import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { vigiarSessoes, type VigiaDeps, type EstadoLido } from './session-watch.js'
import type { LinhaDeSessao } from './dev-session-store.js'
import { MAX_NUDGES } from './jules-session-loop.js'

// Fase 2 da esteira que fecha o ciclo: a Fase 1 (dev-session-store) só guarda
// a ligação issue↔sessão↔PR. Sem alguém lendo essa ligação de volta e agindo,
// criar sessão continua sendo falar sem ouvir — o mesmo defeito medido em
// produção que motivou a Fase 1.

const agora = new Date('2026-01-01T12:00:00.000Z')

function linha(overrides: Partial<LinhaDeSessao> = {}): LinhaDeSessao {
  return {
    id: 'row1',
    projectId: 'proj1',
    issueNumber: 24,
    sessionName: 'sessions/1',
    state: 'IN_PROGRESS',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: agora,
    stateCheckedAt: null,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    ...overrides,
  }
}

function depsFalso(overrides: Partial<VigiaDeps> = {}): VigiaDeps {
  return {
    sessoes: [],
    consultarSessao: vi.fn(async (_sessionName: string): Promise<EstadoLido | null> => null),
    ultimaMensagem: vi.fn(async (_sessionName: string) => ''),
    aprovarPlano: vi.fn(async (_sessionName: string) => true),
    pedirParaContinuar: vi.fn(async (_sessionName: string) => true),
    dispararMissao: vi.fn(async (_papel: 'qa' | 'sm', _projectId: string) => undefined),
    registrarEstado: vi.fn(async (_args: unknown) => undefined),
    registrarResposta: vi.fn(async (_args: unknown) => undefined),
    registrarPr: vi.fn(async (_args: unknown) => undefined),
    fecharSessao: vi.fn(async (_args: unknown) => undefined),
    registrarInvestigacao: vi.fn(async (_args: unknown) => undefined),
    avisarDono: vi.fn(async (_mensagem: string) => undefined),
    agora,
    onWarn: vi.fn(),
    ...overrides,
  }
}

function hashDe(mensagem: string): string {
  return createHash('sha256').update(mensagem).digest('hex').slice(0, 16)
}

describe('vigiarSessoes', () => {
  it('sem sessão viva não faz nenhuma chamada externa — a vigia é escopada, não global', async () => {
    const deps = depsFalso({ sessoes: [] })

    const resultado = await vigiarSessoes(deps)

    expect(resultado).toBe('vigia: nenhuma sessão viva.')
    expect(deps.consultarSessao).not.toHaveBeenCalled()
    expect(deps.ultimaMensagem).not.toHaveBeenCalled()
    expect(deps.dispararMissao).not.toHaveBeenCalled()
    expect(deps.registrarEstado).not.toHaveBeenCalled()
  })

  it('concluída com PR grava o número, dispara QA e NÃO fecha a linha — só o merge fecha (Fase 3)', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/pr' })],
      consultarSessao: vi.fn(async () => ({
        estado: 'COMPLETED',
        numeroDoPr: 63,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.registrarPr).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/pr', numeroDoPr: 63 })
    )
    expect(deps.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
    expect(deps.fecharSessao).not.toHaveBeenCalled()
  })

  it('concluída sem PR dispara SM — trabalho morreu dentro da sessão, quem trata impedimento é o SM', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/sem-pr' })],
      consultarSessao: vi.fn(async () => ({
        estado: 'COMPLETED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.dispararMissao).toHaveBeenCalledWith('sm', 'proj1')
    expect(deps.registrarPr).not.toHaveBeenCalled()
  })

  it('estado FAILED aciona o SM E avisa o dono — a lacuna que deixava a falha em silêncio', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/falhou', issueNumber: 42 })],
      consultarSessao: vi.fn(async () => ({
        estado: 'FAILED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    // Regra 1: o SM continua sendo acionado — isso não muda (decisão D5).
    expect(deps.dispararMissao).toHaveBeenCalledWith('sm', 'proj1')
    // Regra 2: o aviso ao dono é ADICIONAL e precisa ser acionável — issue,
    // sessão e estado lido, além de dizer que o SM foi chamado.
    expect(deps.avisarDono).toHaveBeenCalledWith(expect.stringContaining('#42'))
    expect(deps.avisarDono).toHaveBeenCalledWith(expect.stringContaining('sessions/falhou'))
    expect(deps.avisarDono).toHaveBeenCalledWith(expect.stringContaining('FAILED'))
    expect(deps.avisarDono).toHaveBeenCalledWith(expect.stringMatching(/SM|investig/i))
    expect(deps.registrarInvestigacao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/falhou' })
    )
    // Regra 3: o exame TEM de ser marcado, avisando ou não. A cadência de dez
    // minutos é medida por `stateCheckedAt`; sem esta marca, a sessão presa em
    // FAILED seria reexaminada a cada tick (um minuto) e o SM acionado sessenta
    // vezes por hora, queimando a cota do motor do cliente.
    expect(deps.registrarEstado).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/falhou', estado: 'FAILED' })
    )
  })

  it('aviso ao dono não se repete no ciclo seguinte para a mesma sessão no mesmo estado', async () => {
    const consultarSessao = vi.fn(async () => ({
      estado: 'FAILED',
      numeroDoPr: null,
      ultimaAtualizacao: agora.toISOString(),
    }))

    // Ciclo 1: primeira vez que a vigia vê esta sessão em FAILED.
    const deps1 = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/repete', issueNumber: 7 })],
      consultarSessao,
    })
    await vigiarSessoes(deps1)
    expect(deps1.avisarDono).toHaveBeenCalledTimes(1)

    const hashGravado: string | null =
      vi.mocked(deps1.registrarInvestigacao).mock.calls[0]?.[0]?.hash ?? null
    expect(hashGravado).toBeTruthy()

    // Ciclo 2: mesma sessão, mesmo estado FAILED, e o hash já gravado no
    // ciclo anterior — exatamente o que a leitura seguinte da linha traria.
    // Fora da cadência de 10 min para garantir que o exame realmente acontece
    // (o que se testa aqui é o dedupe do AVISO, não o corte de cadência).
    const deps2 = depsFalso({
      sessoes: [
        linha({
          sessionName: 'sessions/repete',
          issueNumber: 7,
          answeredHash: hashGravado,
          stateCheckedAt: new Date(agora.getTime() - 30 * 60 * 1000),
        }),
      ],
      consultarSessao,
    })
    await vigiarSessoes(deps2)

    // O SM segue sendo acionado todo ciclo — só o aviso ao dono tem teto.
    expect(deps2.dispararMissao).toHaveBeenCalledWith('sm', 'proj1')
    expect(deps2.avisarDono).not.toHaveBeenCalled()
  })

  it('pergunta nova dispara QA e grava o hash', async () => {
    const mensagem = 'Devo usar bcrypt ou argon2 para o hash de senha?'
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/pergunta', answeredHash: null })],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_USER_FEEDBACK',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      ultimaMensagem: vi.fn(async () => mensagem),
    })

    await vigiarSessoes(deps)

    expect(deps.registrarResposta).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'sessions/pergunta',
        hashDaPergunta: hashDe(mensagem),
      })
    )
    expect(deps.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
  })

  it('pergunta REPETIDA (mesmo hash já gravado) NÃO dispara de novo', async () => {
    const mensagem = 'Devo usar bcrypt ou argon2 para o hash de senha?'
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/repetida', answeredHash: hashDe(mensagem) })],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_USER_FEEDBACK',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      ultimaMensagem: vi.fn(async () => mensagem),
    })

    await vigiarSessoes(deps)

    expect(deps.registrarResposta).not.toHaveBeenCalled()
    expect(deps.dispararMissao).not.toHaveBeenCalled()
  })

  it('AWAITING_PLAN_APPROVAL aprova o plano direto, sem gastar motor', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/plano' })],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_PLAN_APPROVAL',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.aprovarPlano).toHaveBeenCalledWith('sessions/plano')
    expect(deps.dispararMissao).not.toHaveBeenCalled()
    // I3 (revisão final): o exame TEM de ser marcado, senão `stateCheckedAt`
    // nunca avança neste ramo e a cadência de dez minutos quebra — uma
    // sessão em AWAITING_PLAN_APPROVAL seria reexaminada a cada tick (um
    // minuto), sessenta vezes por hora em vez de seis. Mesmo remédio do
    // commit 0193bd8 (ramo `investigar`).
    expect(deps.registrarEstado).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/plano', estado: 'AWAITING_PLAN_APPROVAL' })
    )
  })

  it('AWAITING_PLAN_APPROVAL: aprovação falha no serviço externo ainda assim marca o exame', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/plano-falha' })],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_PLAN_APPROVAL',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      aprovarPlano: vi.fn(async () => false),
    })

    await vigiarSessoes(deps)

    expect(deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('sessions/plano-falha'))
    // A cadência não pode depender do sucesso da aprovação — falha ou não,
    // o exame avançou e a sessão só volta a ser olhada daqui a 10 minutos.
    expect(deps.registrarEstado).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'sessions/plano-falha',
        estado: 'AWAITING_PLAN_APPROVAL',
      })
    )
  })

  it('sessão pausada pede para continuar', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/pausada', nudges: 1 })],
      consultarSessao: vi.fn(async () => ({
        estado: 'PAUSED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.pedirParaContinuar).toHaveBeenCalledWith('sessions/pausada')
    expect(deps.registrarResposta).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/pausada' })
    )
  })

  // I3 (revisão final): quando o ENVIO falha (`pedirParaContinuar` devolve
  // `false`), o ramo só avisava (`warn`) e não chamava `registrarResposta` —
  // nem `stateCheckedAt` avançava (cadência quebrada, reexame a cada tick),
  // nem `nudges` (o teto que decide abandono ficava inalcançável: uma falha
  // de envio persistente girava para sempre sem jamais avisar o dono).
  it('insistir com falha no envio ainda assim marca o exame e conta a tentativa', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/insiste-falha', nudges: 1 })],
      consultarSessao: vi.fn(async () => ({
        estado: 'PAUSED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      pedirParaContinuar: vi.fn(async () => false),
    })

    await vigiarSessoes(deps)

    expect(deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('sessions/insiste-falha'))
    // Antes da correção, este `registrarResposta` simplesmente não era
    // chamado quando `pedirParaContinuar` devolvia `false`.
    expect(deps.registrarResposta).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/insiste-falha' })
    )
  })

  it('insistir falhando repetidamente eventualmente atinge o teto e é abandonada — não gira para sempre', async () => {
    // O serviço externo nunca aceita o envio (rede fora do ar, por exemplo).
    const pedirParaContinuar = vi.fn(async () => false)

    // Ciclo 1: nudges começa em MAX_NUDGES - 1. O envio falha.
    const deps1 = depsFalso({
      sessoes: [
        linha({ sessionName: 'sessions/nunca-entrega', issueNumber: 55, nudges: MAX_NUDGES - 1 }),
      ],
      consultarSessao: vi.fn(async () => ({
        estado: 'PAUSED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      pedirParaContinuar,
    })
    await vigiarSessoes(deps1)

    // A tentativa foi contada (é o que faz o teto ser alcançável) — sem a
    // correção, `registrarResposta` nunca dispararia aqui e a sessão
    // giraria em 'insistir' para sempre.
    expect(deps1.registrarResposta).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/nunca-entrega' })
    )
    expect(deps1.fecharSessao).not.toHaveBeenCalled()

    // Ciclo 2: representa o efeito já persistido do incremento do ciclo 1
    // (nudges chegou a MAX_NUDGES) — a mesma sessão, lida de novo pela
    // vigia dez minutos depois.
    const deps2 = depsFalso({
      sessoes: [
        linha({ sessionName: 'sessions/nunca-entrega', issueNumber: 55, nudges: MAX_NUDGES }),
      ],
      consultarSessao: vi.fn(async () => ({
        estado: 'PAUSED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      pedirParaContinuar,
    })
    await vigiarSessoes(deps2)

    expect(deps2.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/nunca-entrega', motivo: 'abandoned' })
    )
    expect(deps2.avisarDono).toHaveBeenCalledWith(expect.stringContaining('#55'))
  })

  it('teto de insistências estourado fecha como abandonada e avisa o dono', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/teto', issueNumber: 99, nudges: MAX_NUDGES })],
      consultarSessao: vi.fn(async () => ({
        estado: 'PAUSED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/teto', motivo: 'abandoned' })
    )
    expect(deps.avisarDono).toHaveBeenCalledWith(expect.stringContaining('#99'))
  })

  it('sessão examinada há 2 minutos é pulada — dentro da cadência de 10 minutos', async () => {
    const deps = depsFalso({
      sessoes: [
        linha({
          sessionName: 'sessions/recente',
          stateCheckedAt: new Date(agora.getTime() - 2 * 60 * 1000),
        }),
      ],
    })

    await vigiarSessoes(deps)

    expect(deps.consultarSessao).not.toHaveBeenCalled()
  })

  it('sessão examinada há 30 minutos é examinada — fora da cadência de 10 minutos', async () => {
    const deps = depsFalso({
      sessoes: [
        linha({
          sessionName: 'sessions/velha',
          stateCheckedAt: new Date(agora.getTime() - 30 * 60 * 1000),
        }),
      ],
      consultarSessao: vi.fn(async () => ({
        estado: 'IN_PROGRESS',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.consultarSessao).toHaveBeenCalledWith('sessions/velha')
  })

  it('sessão nunca examinada (stateCheckedAt nulo) é examinada', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/nova', stateCheckedAt: null })],
      consultarSessao: vi.fn(async () => ({
        estado: 'QUEUED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.consultarSessao).toHaveBeenCalledWith('sessions/nova')
  })

  it('erro numa sessão não impede a seguinte', async () => {
    const consultarSessao = vi.fn(async (sessionName: string): Promise<EstadoLido | null> => {
      if (sessionName === 'sessions/quebra') throw new Error('boom')
      return { estado: 'COMPLETED', numeroDoPr: 7, ultimaAtualizacao: agora.toISOString() }
    })
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/quebra' }), linha({ sessionName: 'sessions/ok' })],
      consultarSessao,
    })

    await vigiarSessoes(deps)

    expect(deps.registrarPr).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/ok' })
    )
    expect(deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('sessions/quebra'))
  })

  it('consultarSessao devolvendo null não altera estado nem dispara nada', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/fora' })],
      consultarSessao: vi.fn(async () => null),
    })

    await vigiarSessoes(deps)

    expect(deps.registrarEstado).not.toHaveBeenCalled()
    expect(deps.dispararMissao).not.toHaveBeenCalled()
    expect(deps.fecharSessao).not.toHaveBeenCalled()
    expect(deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('sessions/fora'))
  })

  it('trabalhando e sem avanço novo só registra o estado, sem marcar progresso', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/parado-no-mesmo', lastProgressAt: agora })],
      consultarSessao: vi.fn(async () => ({
        estado: 'IN_PROGRESS',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(), // igual ao lastProgressAt: nada novo
      })),
    })

    await vigiarSessoes(deps)

    const chamada = vi.mocked(deps.registrarEstado).mock.calls[0]?.[0]
    expect(chamada).toEqual(
      expect.objectContaining({ sessionName: 'sessions/parado-no-mesmo', estado: 'IN_PROGRESS' })
    )
    expect(chamada?.progrediu).toBeUndefined()
    expect(deps.dispararMissao).not.toHaveBeenCalled()
  })

  it('avanço detectado (ultimaAtualizacao mais nova que lastProgressAt) marca progrediu: true', async () => {
    const antes = new Date(agora.getTime() - 5 * 60 * 1000)
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/avancou', lastProgressAt: antes })],
      consultarSessao: vi.fn(async () => ({
        estado: 'IN_PROGRESS',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    const chamada = vi.mocked(deps.registrarEstado).mock.calls[0]?.[0]
    expect(chamada?.progrediu).toBe(true)
  })

  it('resumo final conta sessões e ações do ciclo', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/a' }), linha({ sessionName: 'sessions/b' })],
      consultarSessao: vi.fn(async (sessionName: string) =>
        sessionName === 'sessions/a'
          ? { estado: 'COMPLETED', numeroDoPr: 1, ultimaAtualizacao: agora.toISOString() }
          : { estado: 'COMPLETED', numeroDoPr: null, ultimaAtualizacao: agora.toISOString() }
      ),
    })

    const resultado = await vigiarSessoes(deps)

    expect(resultado).toContain('2 sessões')
    expect(resultado).toContain('1 PR capturado')
    expect(resultado).toContain('1 investigação')
  })
})
