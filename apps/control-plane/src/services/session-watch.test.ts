import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  ESTADO_AGUARDANDO_QA,
  vigiarSessoes,
  type VigiaDeps,
  type EstadoLido,
} from './session-watch.js'
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
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
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
    pedirAnalise: vi.fn(async (_args: unknown) => undefined),
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

  it('concluída SEM PR → fecha a linha (dev-concluiu-sem-entrega) e a issue volta à fila — D51', async () => {
    // Até 29/08 isto acionava o SM em loop e a linha NUNCA fechava (21 de 23
    // sessões presas assim, enchendo as 15 vagas e parando a esteira).
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/sem-pr' })],
      consultarSessao: vi.fn(async () => ({
        estado: 'COMPLETED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'sessions/sem-pr',
        motivo: 'dev-concluiu-sem-entrega',
      })
    )
    expect(deps.dispararMissao).not.toHaveBeenCalledWith('sm', 'proj1')
    expect(deps.registrarPr).not.toHaveBeenCalled()
  })

  it('FAILED sem PR → fecha a linha (dev-falhou); NÃO pede retomada nem aciona o SM em loop', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/falhou', issueNumber: 42 })],
      consultarSessao: vi.fn(async () => ({
        estado: 'FAILED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/falhou', motivo: 'dev-falhou' })
    )
    // D51: nada de pedir retomada a uma sessão que o Jules já deu como FAILED
    // (verificado: :sendMessage não retoma sessão terminal).
    expect(deps.pedirParaContinuar).not.toHaveBeenCalled()
    // O exame continua sendo marcado antes do switch (cadência de 10 min).
    expect(deps.registrarEstado).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/falhou', estado: 'FAILED' })
    )
  })

  it('FAILED COM PR → a vigia NÃO fecha (deixa para o ciclo terminal do scheduler, que tem token do GitHub)', async () => {
    const deps = depsFalso({
      sessoes: [linha({ sessionName: 'sessions/falhou-pr', issueNumber: 7 })],
      consultarSessao: vi.fn(async () => ({
        estado: 'FAILED',
        numeroDoPr: 99,
        ultimaAtualizacao: agora.toISOString(),
      })),
    })

    await vigiarSessoes(deps)

    expect(deps.fecharSessao).not.toHaveBeenCalled()
    // Mas registra o estado — o scheduler pega no próximo ciclo.
    expect(deps.registrarEstado).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/falhou-pr', estado: 'FAILED' })
    )
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

    // A vigília DETECTA e chama quem responde. A contagem de tentativas e o
    // aviso ao dono são de quem age (a missão de QA) — enquanto os dois
    // marcavam, o teto era consumido em dobro e a pergunta abandonada na
    // metade do caminho.
    expect(deps.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
  })

  it('pergunta REPETIDA e ainda sem resposta: TENTA DE NOVO — era aqui que a sessão morria', async () => {
    // O defeito real, medido em 26/08: a marca era gravada ANTES de a resposta
    // existir. Quando a missão que responde falhava, a pergunta ficava marcada
    // como respondida para sempre e a vigília nunca mais tentava. Treze
    // sessões presas assim, a mais antiga havia SETE DIAS — e cada uma
    // congelando uma vaga, até o teto de simultâneas estourar e parar a
    // esteira inteira.
    const mensagem = 'Devo usar bcrypt ou argon2 para o hash de senha?'
    const deps = depsFalso({
      sessoes: [
        linha({ sessionName: 'sessions/repetida', answeredHash: hashDe(mensagem), nudges: 1 }),
      ],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_USER_FEEDBACK',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      })),
      ultimaMensagem: vi.fn(async () => mensagem),
    })

    await vigiarSessoes(deps)

    expect(deps.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
  })

  it('pergunta JÁ respondida e a sessão parada há 24h → fecha e a issue volta à fila (D52)', async () => {
    const mensagem = 'Devo usar bcrypt ou argon2?'
    const deps = depsFalso({
      sessoes: [
        linha({
          sessionName: 'sessions/timeout',
          issueNumber: 88,
          answeredHash: hashDe(mensagem),
          // último avanço há 25h — passou do prazo de 24h.
          lastProgressAt: new Date(agora.getTime() - 25 * 60 * 60 * 1000),
          stateCheckedAt: new Date(agora.getTime() - 30 * 60 * 1000),
        }),
      ],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_USER_FEEDBACK',
        numeroDoPr: null,
        ultimaAtualizacao: new Date(agora.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      })),
      ultimaMensagem: vi.fn(async () => mensagem),
    })

    await vigiarSessoes(deps)

    expect(deps.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/timeout', motivo: 'pergunta-sem-resposta' })
    )
    expect(deps.avisarDono).toHaveBeenCalledWith(expect.stringContaining('#88'))
    // NÃO disparou QA de novo — a resposta já foi dada e não adiantou.
    expect(deps.dispararMissao).not.toHaveBeenCalledWith('qa', 'proj1')
  })

  it('pergunta respondida mas AINDA dentro das 24h → continua chamando o QA, não fecha', async () => {
    const mensagem = 'x?'
    const deps = depsFalso({
      sessoes: [
        linha({
          sessionName: 'sessions/ainda',
          answeredHash: hashDe(mensagem),
          lastProgressAt: new Date(agora.getTime() - 2 * 60 * 60 * 1000),
          stateCheckedAt: new Date(agora.getTime() - 30 * 60 * 1000),
        }),
      ],
      consultarSessao: vi.fn(async () => ({
        estado: 'AWAITING_USER_FEEDBACK',
        numeroDoPr: null,
        ultimaAtualizacao: new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      })),
      ultimaMensagem: vi.fn(async () => mensagem),
    })

    await vigiarSessoes(deps)

    expect(deps.fecharSessao).not.toHaveBeenCalled()
    expect(deps.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
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
    expect(resultado).toContain('1 sessão encerrada')
  })

  describe('a vigia REGISTRA o que viu, mesmo quando não há o que fazer', () => {
    // O defeito medido em 25/08: quando a pergunta é a MESMA de antes, o ramo
    // de resposta saía por um `break` sem registrar. Como `registrarEstado` é
    // quem move `stateCheckedAt`, a sessão congelava no último estado
    // conhecido. Seis sessões que o dev externo dava como esperando resposta
    // estavam gravadas como "trabalhando", com o relógio parado havia NOVE
    // HORAS — seis das quinze vagas do plano presas assim.
    it('mesma pergunta de antes: tenta de novo (sob o teto) E registra o estado', async () => {
      const mensagem = 'Devo usar bcrypt ou argon2?'
      const consultarSessao = vi.fn(async () => ({
        estado: 'AWAITING_USER_FEEDBACK',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      }))
      const primeiro = depsFalso({
        sessoes: [linha({ sessionName: 'sessions/mesma', answeredHash: null })],
        consultarSessao,
        ultimaMensagem: vi.fn(async () => mensagem),
      })
      await vigiarSessoes(primeiro)
      const hashGravado = (
        primeiro.registrarResposta as unknown as {
          mock: { calls: Array<[{ hashDaPergunta: string }]> }
        }
      ).mock.calls[0]?.[0]?.hashDaPergunta

      const segundo = depsFalso({
        sessoes: [
          linha({
            sessionName: 'sessions/mesma',
            answeredHash: hashGravado ?? '',
            stateCheckedAt: new Date(agora.getTime() - 30 * 60 * 1000),
          }),
        ],
        consultarSessao,
        ultimaMensagem: vi.fn(async () => mensagem),
      })
      await vigiarSessoes(segundo)

      // A vigília chama quem responde toda vez que vê a sessão esperando —
      // quem decide se ainda cabe tentativa, e quem conta, é o caminho que
      // age. Aqui só se prova que ela não desiste sozinha nem congela a linha.
      expect(segundo.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
      // Mas REGISTRA o que viu: sem isto a linha congela e a vaga fica presa.
      expect(segundo.registrarEstado).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionName: 'sessions/mesma',
          estado: 'AWAITING_USER_FEEDBACK',
        })
      )
    })

    // A classe inteira do defeito: qualquer estado que o dev externo devolva
    // tem de acabar gravado aqui, senão o relógio de exame para e a cadência
    // de dez minutos vira um laço de um minuto.
    it.each(['AWAITING_USER_FEEDBACK', 'IN_PROGRESS', 'FAILED', 'COMPLETED'])(
      'estado "%s" do dev externo sempre é registrado',
      async (estado) => {
        const deps = depsFalso({
          sessoes: [linha({ sessionName: 'sessions/x', stateCheckedAt: null })],
          consultarSessao: vi.fn(async () => ({
            estado,
            numeroDoPr: null,
            ultimaAtualizacao: agora.toISOString(),
          })),
        })
        await vigiarSessoes(deps)
        expect(deps.registrarEstado).toHaveBeenCalledWith(expect.objectContaining({ estado }))
      }
    )
    describe('FAILED sem PR: a vigia fecha (D51 substitui o antigo "manda continuar")', () => {
      const falhada = vi.fn(async () => ({
        estado: 'FAILED',
        numeroDoPr: null,
        ultimaAtualizacao: agora.toISOString(),
      }))

      // Até 29/08 a vigia pedia retomada a uma sessão FAILED e acionava o SM em
      // loop, sem NUNCA fechar a linha — a vaga ficava presa. D51: a sessão
      // morta fecha e a issue volta para a fila; a esteira redelega.
      it('FAILED sem PR fecha a linha, sem pedir retomada nem acionar o SM', async () => {
        const deps = depsFalso({
          sessoes: [linha({ sessionName: 'sessions/falha', nudges: 0 })],
          consultarSessao: falhada,
        })
        await vigiarSessoes(deps)
        expect(deps.fecharSessao).toHaveBeenCalledWith(
          expect.objectContaining({ sessionName: 'sessions/falha', motivo: 'dev-falhou' })
        )
        expect(deps.pedirParaContinuar).not.toHaveBeenCalled()
        expect(deps.dispararMissao).not.toHaveBeenCalledWith('sm', 'proj1')
      })

      // 2ª falha da MESMA issue (requeueCount 2, sem análise): fecha E pede a
      // análise de "por que" antes da 3ª tentativa (D51).
      it('2ª falha da mesma issue → fecha e pede análise', async () => {
        const deps = depsFalso({
          sessoes: [
            linha({
              sessionName: 'sessions/2x',
              issueNumber: 9,
              requeueCount: 2,
              analysisDoneAt: null,
            }),
          ],
          consultarSessao: falhada,
        })
        await vigiarSessoes(deps)
        expect(deps.fecharSessao).toHaveBeenCalledWith(
          expect.objectContaining({ sessionName: 'sessions/2x', motivo: 'dev-falhou' })
        )
        expect(deps.pedirAnalise).toHaveBeenCalledWith(
          expect.objectContaining({ linha: expect.objectContaining({ issueNumber: 9 }) })
        )
      })
    })

    describe('"PR entregue e aguardando QA" — o terceiro desfecho', () => {
      // O dev externo devolve COMPLETED tanto para a entrega que produziu pull
      // request quanto para a que terminou sem nada. Quem olha o quadro via as
      // duas iguais, e o dono pediu para saber em que pé está cada entrega.
      it('entrega com PR novo fica marcada como aguardando QA', async () => {
        const deps = depsFalso({
          sessoes: [linha({ sessionName: 'sessions/entregou', pullRequestNumber: null })],
          consultarSessao: vi.fn(async () => ({
            estado: 'COMPLETED',
            numeroDoPr: 4242,
            ultimaAtualizacao: agora.toISOString(),
          })),
        })
        await vigiarSessoes(deps)

        expect(deps.registrarPr).toHaveBeenCalledWith(expect.objectContaining({ numeroDoPr: 4242 }))
        expect(deps.registrarEstado).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionName: 'sessions/entregou',
            estado: ESTADO_AGUARDANDO_QA,
          })
        )
        // E o juiz é acordado, que é a outra metade da ordem do dono.
        expect(deps.dispararMissao).toHaveBeenCalledWith('qa', 'proj1')
      })

      // Entrega que terminou sem produzir nada continua sendo o que é: não pode
      // aparecer no quadro como se estivesse esperando julgamento.
      it('entrega concluída SEM pull request não vira aguardando QA', async () => {
        const deps = depsFalso({
          sessoes: [linha({ sessionName: 'sessions/vazia', pullRequestNumber: null })],
          consultarSessao: vi.fn(async () => ({
            estado: 'COMPLETED',
            numeroDoPr: null,
            ultimaAtualizacao: agora.toISOString(),
          })),
        })
        await vigiarSessoes(deps)

        expect(deps.registrarEstado).not.toHaveBeenCalledWith(
          expect.objectContaining({ estado: ESTADO_AGUARDANDO_QA })
        )
      })
    })
  })
})
