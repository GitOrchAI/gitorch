import { describe, it, expect } from 'vitest'
import {
  deveAvisarSobreOMotor,
  nomeAmigavelDoMotor,
  recadoDeMotorRevogado,
} from './recado-de-motor-revogado.js'

describe('recadoDeMotorRevogado — diz o que fazer, não só que quebrou', () => {
  const recado = recadoDeMotorRevogado('codex')

  it('diz QUAL motor, com nome de gente', () => {
    expect(recado).toContain('Codex')
  })

  it('diz o efeito no trabalho, não o erro técnico', () => {
    expect(recado).toMatch(/tarefas automáticas.*paradas/i)
  })

  it('diz o CAMINHO para religar — o dono não é técnico', () => {
    expect(recado).toMatch(/abra o GitOrch/i)
    expect(recado).toMatch(/conecte/i)
  })

  it('NUNCA carrega erro cru do provedor', () => {
    // O erro cru costuma trazer URL de OAuth e pedaços de token, e isso não
    // pode viajar para um chat.
    expect(recado).not.toMatch(/invalid_grant|401|Bearer|refresh.token/i)
  })

  it('motor desconhecido não quebra o recado', () => {
    expect(nomeAmigavelDoMotor('motor-novo')).toBe('motor-novo')
    expect(recadoDeMotorRevogado('motor-novo')).toContain('motor-novo')
  })
})

describe('deveAvisarSobreOMotor — só na virada', () => {
  it('conexão que estava de pé e caiu: avisa', () => {
    expect(deveAvisarSobreOMotor('connected')).toBe(true)
  })

  it('conexão que JÁ estava caída: não repete', () => {
    // A vigília roda de hora em hora. Sem esta regra o mesmo recado chegaria
    // vinte e quatro vezes por dia, e spam apaga sinal tanto quanto silêncio.
    expect(deveAvisarSobreOMotor('needs_reconnect')).toBe(false)
  })

  it('sem status anterior conhecido: avisa — melhor um recado a mais que o silêncio', () => {
    expect(deveAvisarSobreOMotor(null)).toBe(true)
    expect(deveAvisarSobreOMotor(undefined)).toBe(true)
  })
})
