import { describe, it, expect } from 'vitest'
import {
  estadoRealDoMotor,
  motoresComProvaDeVida,
  VALIDADE_DA_PROVA_DE_VIDA_MS,
} from './prova-de-vida.js'

const AGORA = new Date('2026-08-26T12:00:00Z')
const atras = (ms: number) => new Date(AGORA.getTime() - ms)

describe('estadoRealDoMotor — o banco não é a verdade', () => {
  it('respondeu recentemente: vivo', () => {
    const e = estadoRealDoMotor(
      { runtime: 'codex', status: 'connected', lastValidatedAt: atras(60_000) },
      AGORA
    )
    expect(e.estado).toBe('vivo')
  })

  it('diz "connected" mas não responde há vinte dias: SEM PROVA', () => {
    // O caso real, medido hoje: a linha do antigravity dizia 'connected' com a
    // última prova de vida de 06/08. Foi essa mentira que fez o produto
    // disparar treze missões contra um motor morto.
    const e = estadoRealDoMotor(
      { runtime: 'antigravity', status: 'connected', lastValidatedAt: atras(20 * 86_400_000) },
      AGORA
    )
    expect(e.estado).toBe('sem-prova')
    if (e.estado !== 'sem-prova') return
    expect(e.motivo).toMatch(/20 dias/)
  })

  it('nunca provou nada: sem prova, mesmo dizendo "connected"', () => {
    const e = estadoRealDoMotor(
      { runtime: 'codex', status: 'connected', lastValidatedAt: null },
      AGORA
    )
    expect(e.estado).toBe('sem-prova')
  })

  it('a fronteira da validade é respeitada nos dois lados', () => {
    const quase = estadoRealDoMotor(
      {
        runtime: 'codex',
        status: 'connected',
        lastValidatedAt: atras(VALIDADE_DA_PROVA_DE_VIDA_MS - 1),
      },
      AGORA
    )
    expect(quase.estado).toBe('vivo')
    const passou = estadoRealDoMotor(
      {
        runtime: 'codex',
        status: 'connected',
        lastValidatedAt: atras(VALIDADE_DA_PROVA_DE_VIDA_MS),
      },
      AGORA
    )
    expect(passou.estado).toBe('sem-prova')
  })

  it('conexão que o banco já sabe quebrada é dita quebrada, não "sem prova"', () => {
    const e = estadoRealDoMotor(
      { runtime: 'codex', status: 'needs_reconnect', lastValidatedAt: atras(60_000) },
      AGORA
    )
    expect(e.estado).toBe('quebrado')
  })
})

describe('motoresComProvaDeVida — o failover deixa de trocar morto por morto', () => {
  it('só passa quem provou estar vivo', () => {
    const vivos = motoresComProvaDeVida(
      [
        { runtime: 'codex', status: 'connected', lastValidatedAt: atras(60_000) },
        { runtime: 'antigravity', status: 'connected', lastValidatedAt: atras(20 * 86_400_000) },
      ],
      AGORA
    )
    expect(vivos.map((m) => m.runtime)).toEqual(['codex'])
  })

  it('todos sem prova devolve lista vazia — quem chama decide o que fazer', () => {
    // Deliberadamente NÃO devolve todos como recuo: aqui a pergunta é "quem
    // provou estar vivo", e mentir na resposta é o defeito que isto existe
    // para matar. Quem chama tem contexto para decidir se tenta assim mesmo.
    expect(
      motoresComProvaDeVida(
        [{ runtime: 'codex', status: 'connected', lastValidatedAt: null }],
        AGORA
      )
    ).toEqual([])
  })

  it('lista vazia sobrevive', () => {
    expect(motoresComProvaDeVida([], AGORA)).toEqual([])
  })
})
