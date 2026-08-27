import { describe, expect, it } from 'vitest'
import { deveAvisarSobreOMotor } from './recado-de-motor-revogado.js'
import {
  marcaDePedidoDeLogin,
  motivoDeCredencialExpirada,
  precisaReligar,
  STATUS_PRECISA_RELIGAR,
} from './motor-que-pede-login.js'

describe('motor que pede login', () => {
  it('a marca tira o motor de "conectado" — que era a mentira da tela', () => {
    const marca = marcaDePedidoDeLogin('codex')
    expect(marca.status).not.toBe('connected')
    expect(marca.status).toBe(STATUS_PRECISA_RELIGAR)
  })

  it('a marca NUNCA apaga a credencial (só revoke faz isso)', () => {
    // O objeto gravado tem exatamente dois campos: se um dia alguém acrescentar
    // encryptedCredential:null aqui, a renovação posterior perde a chance de
    // ressuscitar uma conexão que ainda podia voltar sozinha.
    expect(Object.keys(marcaDePedidoDeLogin('codex')).sort()).toEqual(['lastError', 'status'])
  })

  it('o motivo não carrega saída crua do provedor — ele vai para tela e banco', () => {
    const motivo = motivoDeCredencialExpirada('codex')
    expect(motivo).not.toMatch(/https?:\/\//)
    expect(motivo).not.toMatch(/401|token|Bearer/i)
    expect(motivo).toContain('codex')
  })

  it('a tela reconhece quem pede login, e só quem pede', () => {
    expect(precisaReligar(STATUS_PRECISA_RELIGAR)).toBe(true)
    expect(precisaReligar('connected')).toBe(false)
    expect(precisaReligar('error')).toBe(false)
    expect(precisaReligar(null)).toBe(false)
    expect(precisaReligar(undefined)).toBe(false)
  })

  it('usa o MESMO valor do anti-spam do recado — senão o dono é reavisado a cada tique', () => {
    // deveAvisarSobreOMotor compara com o status anterior: se a marca gravasse
    // um sinônimo, a virada nunca seria detectada e o aviso viraria spam.
    expect(deveAvisarSobreOMotor(marcaDePedidoDeLogin('codex').status)).toBe(false)
    expect(deveAvisarSobreOMotor('connected')).toBe(true)
  })
})
