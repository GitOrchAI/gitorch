import { describe, it, expect } from 'vitest'
import {
  sessoesAbandonadas,
  HORAS_SEM_PROGRESSO_ATE_ABANDONAR,
  TETO_POR_VARREDURA,
  type LinhaParaJulgar,
} from './sessao-abandonada.js'

const AGORA = new Date('2026-08-24T19:00:00Z')
const HORA = 60 * 60 * 1000

function linha(over: Partial<LinhaParaJulgar> = {}): LinhaParaJulgar {
  return {
    sessionName: 'sessions/1',
    issueNumber: 3744,
    state: 'IN_PROGRESS',
    lastProgressAt: new Date(AGORA.getTime() - HORA),
    createdAt: new Date(AGORA.getTime() - 2 * HORA),
    closedAt: null,
    ...over,
  }
}

describe('sessoesAbandonadas', () => {
  // O caso real: sete sessões paradas desde 21/08 01:11, noventa horas antes,
  // segurando as vagas de um teto de quinze e fazendo o SM "voltar vazio".
  it('acha as sete que travaram a esteira', () => {
    const paradasHa90h = [104, 3744, 3746, 90, 3745, 53, 93].map((issueNumber) =>
      linha({
        issueNumber,
        sessionName: `sessions/${issueNumber}`,
        lastProgressAt: new Date(AGORA.getTime() - 90 * HORA),
      })
    )
    const achadas = sessoesAbandonadas({ linhas: paradasHa90h, agora: AGORA })
    expect(achadas).toHaveLength(7)
    expect(achadas.map((l) => l.issueNumber).sort((a, b) => a - b)).toEqual([
      53, 90, 93, 104, 3744, 3745, 3746,
    ])
  })

  // O extremo oposto, e o mais caro: matar sessão que ainda trabalha jogaria
  // fora o trabalho do dev.
  it('sessão que ANDOU há pouco não é tocada, por mais velha que seja', () => {
    const velhaMasViva = linha({
      createdAt: new Date(AGORA.getTime() - 300 * HORA),
      lastProgressAt: new Date(AGORA.getTime() - 10 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [velhaMasViva], agora: AGORA })).toEqual([])
  })

  it('exatamente no limite ainda vale — o corte é depois, não em cima', () => {
    const noLimite = linha({
      lastProgressAt: new Date(AGORA.getTime() - HORAS_SEM_PROGRESSO_ATE_ABANDONAR * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [noLimite], agora: AGORA })).toEqual([])
  })

  it('um minuto além do limite é abandono', () => {
    const passou = linha({
      lastProgressAt: new Date(AGORA.getTime() - HORAS_SEM_PROGRESSO_ATE_ABANDONAR * HORA - 60_000),
    })
    expect(sessoesAbandonadas({ linhas: [passou], agora: AGORA })).toHaveLength(1)
  })

  it('sem progresso nenhum, conta do nascimento', () => {
    const nuncaAndou = linha({
      lastProgressAt: null,
      createdAt: new Date(AGORA.getTime() - 50 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [nuncaAndou], agora: AGORA })).toHaveLength(1)
  })

  // "Não sei" jamais pode virar "está velha": fechar por ignorância jogaria
  // fora o trabalho do dev sem nenhuma evidência.
  it('linha sem data nenhuma NÃO é abandonada', () => {
    const semData = linha({ lastProgressAt: null, createdAt: null })
    expect(sessoesAbandonadas({ linhas: [semData], agora: AGORA })).toEqual([])
  })

  it('data ilegível também não abandona', () => {
    const quebrada = linha({ lastProgressAt: new Date('não é data') })
    expect(sessoesAbandonadas({ linhas: [quebrada], agora: AGORA })).toEqual([])
  })

  // Relógio adiantado no registro: isso é "acabou de acontecer", nunca "muito
  // tempo atrás".
  it('data no futuro não abandona', () => {
    const futuro = linha({ lastProgressAt: new Date(AGORA.getTime() + 5 * HORA) })
    expect(sessoesAbandonadas({ linhas: [futuro], agora: AGORA })).toEqual([])
  })

  it('linha já fechada não tem vaga para devolver', () => {
    const fechada = linha({
      lastProgressAt: new Date(AGORA.getTime() - 90 * HORA),
      closedAt: new Date(AGORA.getTime() - 80 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [fechada], agora: AGORA })).toEqual([])
  })

  // Chamar de "abandonada" uma entrega que já foi mesclada ou que falhou
  // embaralharia o que de fato aconteceu com ela.
  it.each(['COMPLETED', 'FAILED', 'MERGED'])('estado "%s" não é abandono', (state) => {
    const parada = linha({ state, lastProgressAt: new Date(AGORA.getTime() - 90 * HORA) })
    expect(sessoesAbandonadas({ linhas: [parada], agora: AGORA })).toEqual([])
  })

  it.each(['QUEUED', 'IN_PROGRESS', 'AWAITING_USER_FEEDBACK'])(
    'estado "%s" ainda podia andar, então conta',
    (state) => {
      const parada = linha({ state, lastProgressAt: new Date(AGORA.getTime() - 90 * HORA) })
      expect(sessoesAbandonadas({ linhas: [parada], agora: AGORA })).toHaveLength(1)
    }
  )

  // D64 (deriva do dono) + L4-T3 (escalada:) + L4-T4 (fix-up
  // a13a42f8-2953-4259-b41f-3f8cddb304cd): a dúvida escalada ao dono tem que
  // SOBREVIVER às 24h para a suposição do RA disparar — 24h > 12h do teto de
  // abandono, então sem esta exceção o watchdog fechava a sessão antes.
  it('AWAITING escalada ao dono NÃO é abandonada mesmo muito além do limite de 12h (D64/L4-T3/L4-T4)', () => {
    const escalada = linha({
      state: 'AWAITING_USER_FEEDBACK',
      answeredHash: 'escalada:0:abc123',
      lastProgressAt: new Date(AGORA.getTime() - 25 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [escalada], agora: AGORA })).toEqual([])
  })

  it('AWAITING sem marca de escalada continua com a regra de 12h de sempre', () => {
    const semMarca = linha({
      state: 'AWAITING_USER_FEEDBACK',
      answeredHash: null,
      lastProgressAt: new Date(AGORA.getTime() - 13 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [semMarca], agora: AGORA })).toHaveLength(1)
  })

  it('AWAITING com marca "respondida" (não escalada) continua com a regra de 12h de sempre', () => {
    const respondida = linha({
      state: 'AWAITING_USER_FEEDBACK',
      answeredHash: 'respondida:0:abc123',
      lastProgressAt: new Date(AGORA.getTime() - 13 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [respondida], agora: AGORA })).toHaveLength(1)
  })

  it('IN_PROGRESS não ganha a exceção mesmo com marca "escalada:" residual — só AWAITING_USER_FEEDBACK pausa o relógio', () => {
    const emProgresso = linha({
      state: 'IN_PROGRESS',
      answeredHash: 'escalada:0:abc123',
      lastProgressAt: new Date(AGORA.getTime() - 13 * HORA),
    })
    expect(sessoesAbandonadas({ linhas: [emProgresso], agora: AGORA })).toHaveLength(1)
  })

  it('o teto corta a varredura, para nada fechar em massa sem ninguém ver', () => {
    const muitas = Array.from({ length: TETO_POR_VARREDURA + 10 }, (_, i) =>
      linha({
        sessionName: `sessions/${i}`,
        issueNumber: i,
        lastProgressAt: new Date(AGORA.getTime() - (20 + i) * HORA),
      })
    )
    expect(sessoesAbandonadas({ linhas: muitas, agora: AGORA })).toHaveLength(TETO_POR_VARREDURA)
  })

  // Quando o teto corta, as mais paradas saem primeiro: são as vagas mais
  // seguras de devolver.
  it('devolve da mais parada para a menos', () => {
    const linhas = [
      linha({ sessionName: 'nova', lastProgressAt: new Date(AGORA.getTime() - 13 * HORA) }),
      linha({ sessionName: 'antiga', lastProgressAt: new Date(AGORA.getTime() - 90 * HORA) }),
      linha({ sessionName: 'media', lastProgressAt: new Date(AGORA.getTime() - 40 * HORA) }),
    ]
    expect(sessoesAbandonadas({ linhas, agora: AGORA }).map((l) => l.sessionName)).toEqual([
      'antiga',
      'media',
      'nova',
    ])
  })

  it('lista vazia não quebra', () => {
    expect(sessoesAbandonadas({ linhas: [], agora: AGORA })).toEqual([])
  })
})
