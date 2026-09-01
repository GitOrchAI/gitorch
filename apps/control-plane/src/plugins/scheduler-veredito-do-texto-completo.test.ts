import { describe, expect, test } from 'vitest'
import { isEngineFault } from './scheduler.js'
import {
  classificarFalhaDoMotor,
  marcarFailoverDoTextoCompleto,
  temMarcaDeFailover,
} from '../services/resumo-de-erro-do-motor.js'

// Este arquivo cobre o AGRAVANTE do defeito do log: não era só o log que ficava
// pobre — a DECISÃO de trocar de motor era tomada sobre o texto já cortado.
//
// `isFailoverError` casa 'unauthor' e '401'. No stderr real do Codex as duas
// coisas moram no byte 674, muito além dos 300 guardados. Resultado medido: uma
// falha de autenticação — o motivo mais claro que existe para cair na reserva —
// era classificada como "não é caso de failover", e a missão morria no motor
// desconectado em vez de passar para o seguinte.
const STDERR_LONGO_COM_401 =
  'Reading additional input from stdin...\n' +
  'x'.repeat(600) +
  '\nERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication\n'

describe('o veredito de failover vem do texto COMPLETO, não do que sobrou', () => {
  test('erro genérico com lastError truncado: a marca salva a decisão', () => {
    // Com teto apertado o motivo não cabe no resumo de jeito nenhum...
    const classificada = classificarFalhaDoMotor({ bruto: STDERR_LONGO_COM_401, teto: 40 })
    expect(classificada.ehFailover).toBe(true)

    const err = marcarFailoverDoTextoCompleto(new Error(classificada.mensagem), true)

    // ...e mesmo assim o produto sabe que é caso de trocar de motor, porque o
    // veredito viajou junto com o erro em vez de ser recalculado do resumo.
    expect(isEngineFault(err, classificada.mensagem)).toBe(true)
  })

  test('sem a marca e com o texto cortado, a decisão seria a ERRADA: prova do defeito', () => {
    const truncadoComoAntes = STDERR_LONGO_COM_401.slice(0, 300)
    expect(isEngineFault(new Error(truncadoComoAntes), truncadoComoAntes)).toBe(false)
  })

  test('a marca não inventa failover: erro que não é de motor continua não sendo', () => {
    const classificada = classificarFalhaDoMotor({ bruto: 'erro de sintaxe em x.ts', teto: 300 })
    expect(classificada.ehFailover).toBe(false)
    const err = marcarFailoverDoTextoCompleto(new Error(classificada.mensagem), false)
    expect(temMarcaDeFailover(err)).toBe(false)
    expect(isEngineFault(err, classificada.mensagem)).toBe(false)
  })

  test('a marca sobrevive ao próprio objeto de erro, e não vaza para outros', () => {
    const marcado = marcarFailoverDoTextoCompleto(new Error('a'), true)
    expect(temMarcaDeFailover(marcado)).toBe(true)
    expect(temMarcaDeFailover(new Error('a'))).toBe(false)
    expect(temMarcaDeFailover(undefined)).toBe(false)
    expect(temMarcaDeFailover('texto solto')).toBe(false)
  })
})
