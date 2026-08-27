import { describe, it, expect } from 'vitest'
import {
  agruparPorProvedor,
  ANTECEDENCIA_DA_RENOVACAO_MS,
  decidirRenovacaoDoMotor,
  ehRevogacaoDefinitiva,
  OCIOSIDADE_QUE_PEDE_RENOVACAO_MS,
} from './renovar-motores.js'

const AGORA = new Date('2026-08-26T12:00:00Z')
const atras = (ms: number) => new Date(AGORA.getTime() - ms)
const adiante = (ms: number) => new Date(AGORA.getTime() + ms)

describe('decidirRenovacaoDoMotor', () => {
  it('token perto de vencer: renova antes', () => {
    const d = decidirRenovacaoDoMotor(
      { status: 'connected', expiresAt: adiante(60_000), updatedAt: AGORA },
      AGORA
    )
    expect(d.tipo).toBe('renovar')
  })

  it('token já vencido: renova, e diz isso', () => {
    const d = decidirRenovacaoDoMotor(
      { status: 'connected', expiresAt: atras(60_000), updatedAt: AGORA },
      AGORA
    )
    expect(d.tipo).toBe('renovar')
    expect(d.motivo).toMatch(/venceu/i)
  })

  it('token com prazo de sobra: não mexe', () => {
    const d = decidirRenovacaoDoMotor(
      {
        status: 'connected',
        expiresAt: adiante(ANTECEDENCIA_DA_RENOVACAO_MS * 3),
        updatedAt: AGORA,
      },
      AGORA
    )
    expect(d.tipo).toBe('nada')
  })

  it('SEM vencimento e parada há dias: renova — é o motor que morre calado', () => {
    // O caso real: expiresAt é NULO para os motores, e foi por isso que a
    // checagem de vencimento nunca barrou nada e o codex morreu em 29/07 sem
    // ninguém notar.
    const d = decidirRenovacaoDoMotor(
      {
        status: 'connected',
        expiresAt: null,
        updatedAt: atras(OCIOSIDADE_QUE_PEDE_RENOVACAO_MS),
      },
      AGORA
    )
    expect(d.tipo).toBe('renovar')
    expect(d.motivo).toMatch(/sem uso/i)
  })

  it('sem vencimento mas usada há pouco: não mexe — o próprio uso renova', () => {
    const d = decidirRenovacaoDoMotor(
      { status: 'connected', expiresAt: null, updatedAt: atras(60_000) },
      AGORA
    )
    expect(d.tipo).toBe('nada')
  })

  it('sem vencimento e nunca usada: renova', () => {
    const d = decidirRenovacaoDoMotor(
      { status: 'connected', expiresAt: null, updatedAt: null },
      AGORA
    )
    expect(d.tipo).toBe('renovar')
  })

  it('conexão que não está de pé é deixada em paz', () => {
    for (const status of ['needs_reconnect', 'disconnected', 'pending']) {
      const d = decidirRenovacaoDoMotor(
        { status, expiresAt: atras(60_000), updatedAt: null },
        AGORA
      )
      expect(d.tipo).toBe('nada')
    }
  })
})

describe('agruparPorProvedor — a armadilha do refresh token rotativo', () => {
  it('contas do MESMO provedor ficam no mesmo grupo, para irem em série', () => {
    // Em alguns provedores o refresh token é rotativo: renovar a conta de um
    // cliente invalida a chave que outra conta do MESMO provedor ainda ia usar.
    const grupos = agruparPorProvedor([
      { runtime: 'codex', userId: 'a' },
      { runtime: 'codex', userId: 'b' },
    ])
    expect(grupos).toHaveLength(1)
    expect(grupos[0]).toHaveLength(2)
  })

  it('provedores diferentes ficam em grupos diferentes — podem correr juntos', () => {
    const grupos = agruparPorProvedor([
      { runtime: 'codex', userId: 'a' },
      { runtime: 'antigravity', userId: 'a' },
    ])
    expect(grupos).toHaveLength(2)
  })

  it('lista vazia não vira grupo nenhum', () => {
    expect(agruparPorProvedor([])).toEqual([])
  })

  it('ninguém se perde no agrupamento', () => {
    const entrada = [
      { runtime: 'codex', userId: 'a' },
      { runtime: 'codex', userId: 'b' },
      { runtime: 'claude', userId: 'c' },
    ]
    expect(agruparPorProvedor(entrada).flat()).toHaveLength(entrada.length)
  })
})

describe('ehRevogacaoDefinitiva — só revogação real incomoda o cliente', () => {
  it('sinal de revogação é definitivo', () => {
    expect(ehRevogacaoDefinitiva('error: invalid_grant')).toBe(true)
    expect(ehRevogacaoDefinitiva('token has been revoked')).toBe(true)
  })

  it('falha de rede é transitória — o cliente não é incomodado por isso', () => {
    // A promessa do dono: se a renovação parar por defeito nosso, o conserto é
    // nosso. Só revogação real gera pedido de reconexão.
    expect(ehRevogacaoDefinitiva('connect ETIMEDOUT')).toBe(false)
    expect(ehRevogacaoDefinitiva('502 Bad Gateway')).toBe(false)
    expect(ehRevogacaoDefinitiva('')).toBe(false)
  })

  it('na dúvida, transitório — marcar como revogado é destrutivo', () => {
    expect(ehRevogacaoDefinitiva('algo estranho aconteceu')).toBe(false)
  })
})
