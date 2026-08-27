import { describe, expect, it } from 'vitest'
import { ehCredencialExpirada } from './credencial-do-motor.js'
import { ehTetoDeUsoDaConta, quandoACotaVolta, recadoDeTetoDeUso } from './teto-de-uso-da-conta.js'

// A saida LITERAL do provedor, capturada rodando o CLI na mao em 27/08.
const CODEX_NO_TETO =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)"
const ANTIGRAVITY_NO_TETO =
  'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15h41m4s.'

describe('teto de uso da conta', () => {
  it('reconhece o texto REAL do Codex — que o produto ignorava', () => {
    expect(ehTetoDeUsoDaConta(CODEX_NO_TETO)).toBe(true)
  })

  it('reconhece o texto real do Antigravity', () => {
    expect(ehTetoDeUsoDaConta(ANTIGRAVITY_NO_TETO)).toBe(true)
  })

  it('trabalho comum não vira teto de uso', () => {
    expect(ehTetoDeUsoDaConta('erro: o teste X quebrou na linha 40')).toBe(false)
    expect(ehTetoDeUsoDaConta('PR aberto com sucesso')).toBe(false)
  })

  it('teto de uso NÃO é credencial vencida — a distinção que custou dois logins', () => {
    // O dono religou o Codex duas vezes no mesmo dia por causa desta confusão.
    const saida = { stdout: CODEX_NO_TETO, stderr: '', exitCode: 1 }
    expect(ehTetoDeUsoDaConta(CODEX_NO_TETO)).toBe(true)
    expect(ehCredencialExpirada(saida)).toBe(false)
  })

  it('lê o prazo quando o provedor informa', () => {
    expect(quandoACotaVolta(ANTIGRAVITY_NO_TETO)).toBe('15h41m')
  })

  it('sem prazo devolve nulo em vez de inventar um', () => {
    // Prazo errado é pior que nenhum: o dono organiza o dia em cima dele.
    expect(quandoACotaVolta(CODEX_NO_TETO)).toBeNull()
  })

  it('o recado NÃO pede para religar — foi esse pedido que gastou o tempo dele', () => {
    const texto = recadoDeTetoDeUso({ runtime: 'codex', volta: null })
    expect(texto).toContain('NÃO é login vencido')
    expect(texto).not.toMatch(/reconecte|religue o motor de novo/i)
    expect(texto).toContain('não é preciso')
  })

  it('com prazo, o recado diz quando volta', () => {
    expect(recadoDeTetoDeUso({ runtime: 'antigravity', volta: '15h41m' })).toContain('15h41m')
  })
})
