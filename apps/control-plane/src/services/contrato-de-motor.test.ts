import { afterEach, describe, expect, test } from 'vitest'
import {
  conferirContratoDeMotores,
  registrarContratoDeMotoresNoBoot,
  motorEstaInutilizavel,
  _resetMotoresInutilizaveisParaTeste,
} from './contrato-de-motor.js'

describe('conferirContratoDeMotores', () => {
  test('todos os runtimes com descobridor e leitor -> sem quebras', () => {
    const quebras = conferirContratoDeMotores(
      ['claude', 'codex'],
      { claude: () => {}, codex: () => {} },
      { claude: () => {}, codex: () => {} }
    )
    expect(quebras).toEqual([])
  })

  test('runtime sem descobridor de catálogo -> quebra com motivo claro', () => {
    const quebras = conferirContratoDeMotores(['claude'], {}, { claude: () => {} })
    expect(quebras).toEqual([
      { runtime: 'claude', motivo: expect.stringContaining('descobridor de catálogo') },
    ])
  })

  test('runtime sem leitor de cota -> quebra com motivo claro', () => {
    const quebras = conferirContratoDeMotores(['claude'], { claude: () => {} }, {})
    expect(quebras).toEqual([
      { runtime: 'claude', motivo: expect.stringContaining('leitor de cota') },
    ])
  })

  test('runtime sem os dois -> uma única quebra dizendo os dois', () => {
    const quebras = conferirContratoDeMotores(['fantasma'], {}, {})
    expect(quebras).toHaveLength(1)
    expect(quebras[0]?.motivo).toContain('descobridor de catálogo')
    expect(quebras[0]?.motivo).toContain('leitor de cota')
  })

  // Object.hasOwn, não `in`/checagem de falsy: mesma defesa de prototype
  // pollution já aplicada em engine-connection.ts — um objeto-literal herda
  // de Object.prototype, e 'constructor'/'toString' não podem passar como se
  // fossem um descobridor de verdade.
  test('propriedade herdada de Object.prototype não conta como descobridor/leitor real', () => {
    const quebras = conferirContratoDeMotores(['constructor'], {}, {})
    expect(quebras).toEqual([
      {
        runtime: 'constructor',
        motivo: expect.stringContaining('descobridor de catálogo'),
      },
    ])
  })
})

describe('registrarContratoDeMotoresNoBoot', () => {
  afterEach(() => _resetMotoresInutilizaveisParaTeste())

  test('loga UM erro claro por motor quebrado — nunca silencioso', () => {
    const erros: Array<{ obj: unknown; msg: string | undefined }> = []
    const log = { error: (obj: unknown, msg?: string) => erros.push({ obj, msg }) }

    registrarContratoDeMotoresNoBoot(log, ['claude', 'codex'], { codex: () => {} }, {})

    expect(erros).toHaveLength(2)
    expect(erros.map((e) => e.msg).join('\n')).toContain('claude')
    expect(erros.map((e) => e.msg).join('\n')).toContain('codex')
  })

  test('marca cada motor quebrado como inutilizável, sem lançar e sem derrubar nada', () => {
    expect(motorEstaInutilizavel('claude')).toBe(false)
    const log = { error: () => undefined }
    expect(() =>
      registrarContratoDeMotoresNoBoot(log, ['claude'], {}, { claude: () => {} })
    ).not.toThrow()
    expect(motorEstaInutilizavel('claude')).toBe(true)
    // Um motor íntegro não é afetado pela quebra de outro.
    expect(motorEstaInutilizavel('codex')).toBe(false)
  })

  test('contrato íntegro não loga nada nem marca ninguém', () => {
    const erros: unknown[] = []
    const log = { error: (obj: unknown) => erros.push(obj) }
    registrarContratoDeMotoresNoBoot(log, ['claude'], { claude: () => {} }, { claude: () => {} })
    expect(erros).toHaveLength(0)
    expect(motorEstaInutilizavel('claude')).toBe(false)
  })

  test('sem argumentos, confere os runtimes de motor reais de produção (MODEL_DISCOVERERS/QUOTA_READERS) e não acusa quebra nenhuma', () => {
    const erros: unknown[] = []
    const log = { error: (obj: unknown) => erros.push(obj) }
    registrarContratoDeMotoresNoBoot(log)
    expect(erros).toEqual([])
  })
})
