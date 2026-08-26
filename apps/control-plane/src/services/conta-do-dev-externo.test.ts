import { describe, it, expect } from 'vitest'
import {
  CONTA_DA_INSTANCIA,
  contaDoDevExterno,
  dividemAMesmaConta,
  folgaDaConta,
} from './conta-do-dev-externo.js'

describe('contaDoDevExterno', () => {
  it('sem credencial própria, é a conta da instância', () => {
    expect(contaDoDevExterno({})).toBe(CONTA_DA_INSTANCIA)
    expect(contaDoDevExterno(null)).toBe(CONTA_DA_INSTANCIA)
    expect(contaDoDevExterno({ credencialDoDevId: null })).toBe(CONTA_DA_INSTANCIA)
  })

  it('com credencial própria (BYOK), é a do cliente', () => {
    expect(contaDoDevExterno({ credencialDoDevId: 'cred_do_cliente_a' })).toBe('cred_do_cliente_a')
  })

  it('credencial em branco não vira conta separada', () => {
    expect(contaDoDevExterno({ credencialDoDevId: '   ' })).toBe(CONTA_DA_INSTANCIA)
  })
})

describe('dividemAMesmaConta', () => {
  // O caso medido: dois projetos sem credencial própria dividem a conta do
  // dono, e é por isso que a contagem deles PRECISA somar.
  it('dois projetos sem credencial própria somam a mesma cota', () => {
    expect(dividemAMesmaConta({}, {})).toBe(true)
  })

  it('clientes diferentes com BYOK não somam', () => {
    expect(
      dividemAMesmaConta({ credencialDoDevId: 'cliente_a' }, { credencialDoDevId: 'cliente_b' })
    ).toBe(false)
  })

  it('dois projetos do MESMO cliente continuam somando', () => {
    expect(
      dividemAMesmaConta({ credencialDoDevId: 'cliente_a' }, { credencialDoDevId: 'cliente_a' })
    ).toBe(true)
  })
})

describe('folgaDaConta', () => {
  const PRO = { tetoDiario: 100, tetoConcorrentes: 15 }

  it('conta vazia cabe o teto de simultâneas', () => {
    const f = folgaDaConta({ uso: { delegadasNaJanela: 0, vivasAgora: 0 }, ...PRO })
    expect(f.cabem).toBe(15)
    expect(f.limitadoPor).toBe('nenhum')
  })

  // O caso real de 25/08: dois projetos "pro" somando contra UM teto.
  it('a soma dos projetos é que conta, não cada um por si', () => {
    const f = folgaDaConta({ uso: { delegadasNaJanela: 100, vivasAgora: 2 }, ...PRO })
    expect(f.cabem).toBe(0)
    expect(f.limitadoPor).toBe('diario')
  })

  // Os dois tetos são contadores diferentes: o de vagas libera na hora que uma
  // sessão termina; o de 24h só devolve cada sessão 24h depois de começar.
  it('vaga cheia trava mesmo com o dia inteiro sobrando', () => {
    const f = folgaDaConta({ uso: { delegadasNaJanela: 20, vivasAgora: 15 }, ...PRO })
    expect(f.cabem).toBe(0)
    expect(f.limitadoPor).toBe('concorrentes')
  })

  it('manda o teto mais apertado dos dois', () => {
    const f = folgaDaConta({ uso: { delegadasNaJanela: 97, vivasAgora: 5 }, ...PRO })
    expect(f.cabem).toBe(3)
  })

  // O recado ao dono precisa dizer a verdade: "espere amanhã" é diferente de
  // "espere uma sessão terminar".
  it('no empate, quem manda é o diário — porque só o tempo resolve', () => {
    const f = folgaDaConta({ uso: { delegadasNaJanela: 100, vivasAgora: 15 }, ...PRO })
    expect(f.limitadoPor).toBe('diario')
  })

  // Estouro já acontecido não vira crédito negativo que depois "sobra".
  it('conta estourada devolve zero, nunca negativo', () => {
    const f = folgaDaConta({ uso: { delegadasNaJanela: 140, vivasAgora: 30 }, ...PRO })
    expect(f.cabem).toBe(0)
  })

  it('o plano gratuito é bem mais apertado', () => {
    const f = folgaDaConta({
      uso: { delegadasNaJanela: 0, vivasAgora: 0 },
      tetoDiario: 15,
      tetoConcorrentes: 3,
    })
    expect(f.cabem).toBe(3)
  })
})
