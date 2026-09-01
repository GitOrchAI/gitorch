import { describe, it, expect } from 'vitest'
import {
  precisaRecoletarModelos,
  modelosARecoletar,
  INTERVALO_DE_RECOLETA_H,
} from './modelos-a-recoletar.js'

const AGORA = new Date('2026-09-01T12:00:00.000Z')
const conexao = (over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  runtime: 'antigravity',
  status: 'connected',
  modelsCheckedAt: null as Date | string | null,
  ...over,
})

describe('modelos-a-recoletar — o catálogo vem pelo RELÓGIO, não por missão completada', () => {
  it('o catálogo real do banco, parado desde 31/08 16:12, é recoletado no dia seguinte', () => {
    // MEDIDO no banco em 01/09/2026 03:00:
    //   antigravity | connected | 14 modelos | models_refreshed_at 2026-08-31 16:12
    // e `agy models` ao vivo no mesmo instante devolve 11 — sem nenhum 3.5.
    // O banco passou a madrugada afirmando que `Gemini 3.5 Flash (Medium)`
    // existia, e é ESSE catálogo que a guarda consulta para decidir a missão.
    //
    // Honestidade sobre o alcance desta correção, porque o número desmente a
    // primeira leitura: às 03:00 daquela noite tinham passado ~10h48 desde a
    // coleta, e com cadência de um dia essa linha AINDA não estaria vencida.
    // Quem cobre a janela de horas é a substituição por família+esforço de
    // `escolherModeloVivo`; o relógio é o que impede a lista de envelhecer sem
    // fim quando nenhuma missão completa — que era o estado anterior, sem teto
    // nenhum. Vencida de verdade é a linha do dia anterior:
    const umDiaDepois = new Date('2026-09-01T16:12:26.599Z')
    expect(
      precisaRecoletarModelos(
        conexao({ modelsCheckedAt: new Date('2026-08-31T16:12:26.599Z') }),
        umDiaDepois
      )
    ).toBe(true)
    // E, na prática, a coluna nasce NULA em todas as linhas que já existem —
    // então a primeira passada do relógio depois do deploy coleta todas elas.
    expect(precisaRecoletarModelos(conexao({ modelsCheckedAt: null }), AGORA)).toBe(true)
  })

  it('coletado há pouco não é recoletado — rodar o binário do motor não é de graça', () => {
    expect(
      precisaRecoletarModelos(
        conexao({ modelsCheckedAt: new Date('2026-09-01T06:00:00.000Z') }),
        AGORA
      )
    ).toBe(false)
  })

  it('NUNCA coletado coleta agora — é o motor que nunca completou missão nenhuma', () => {
    expect(precisaRecoletarModelos(conexao({ modelsCheckedAt: null }), AGORA)).toBe(true)
  })

  it('carimbo ilegível é "não sei quando li" e vale como vencido', () => {
    expect(precisaRecoletarModelos(conexao({ modelsCheckedAt: 'não é data' }), AGORA)).toBe(true)
  })

  it('só motor CONECTADO tem catálogo para ler', () => {
    for (const status of ['error', 'revoked', 'needs_reconnect', 'pending', 'expired']) {
      expect(precisaRecoletarModelos(conexao({ status }), AGORA)).toBe(false)
    }
  })

  it('a cadência é de UM DIA — a da cota, de 1 hora, fica onde está', () => {
    expect(INTERVALO_DE_RECOLETA_H).toBe(24)
    const quaseUmDia = new Date(AGORA.getTime() - 23 * 60 * 60_000)
    const umDia = new Date(AGORA.getTime() - 24 * 60 * 60_000)
    expect(precisaRecoletarModelos(conexao({ modelsCheckedAt: quaseUmDia }), AGORA)).toBe(false)
    expect(precisaRecoletarModelos(conexao({ modelsCheckedAt: umDia }), AGORA)).toBe(true)
  })

  it('modelosARecoletar devolve só as vencidas, preservando a linha inteira', () => {
    const vencida = conexao({ runtime: 'antigravity', modelsCheckedAt: null })
    const emDia = conexao({
      runtime: 'claude',
      modelsCheckedAt: new Date('2026-09-01T11:00:00.000Z'),
    })
    const caida = conexao({ runtime: 'codex', status: 'needs_reconnect', modelsCheckedAt: null })
    expect(modelosARecoletar([vencida, emDia, caida], AGORA)).toEqual([vencida])
  })
})
