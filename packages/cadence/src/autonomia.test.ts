import { describe, it, expect } from 'vitest'
import {
  podeEscrever,
  exigirPermissao,
  normalizarNivel,
  menorNivelQuePermite,
  EscritaNaoAutorizadaError,
  NIVEIS_DE_AUTONOMIA,
  ACOES_NO_REPOSITORIO,
  NIVEL_PADRAO,
  type NivelDeAutonomia,
  type AcaoNoRepositorio,
} from './autonomia'

// As doze casas da tabela, escritas à mão. É de propósito que este mapa NÃO
// venha do código: se ele fosse derivado da mesma tabela que está sendo
// testada, o teste concordaria com qualquer coisa que o código dissesse.
const ESPERADO: Record<NivelDeAutonomia, Record<AcaoNoRepositorio, boolean>> = {
  so_olhar: { ler: true, organizar: false, propor: false, mesclar: false },
  sugerir: { ler: true, organizar: true, propor: true, mesclar: false },
  cuidar: { ler: true, organizar: true, propor: true, mesclar: true },
}

describe('podeEscrever — as 12 combinações, uma a uma', () => {
  for (const nivel of NIVEIS_DE_AUTONOMIA) {
    for (const acao of ACOES_NO_REPOSITORIO) {
      const esperado = ESPERADO[nivel][acao]
      it(`${nivel} + ${acao} => ${esperado ? 'PODE' : 'NÃO pode'}`, () => {
        expect(podeEscrever(nivel, acao).pode).toBe(esperado)
      })
    }
  }

  it('são exatamente 3 níveis e 4 ações — 12 casas, nem uma a mais', () => {
    expect(NIVEIS_DE_AUTONOMIA).toHaveLength(3)
    expect(ACOES_NO_REPOSITORIO).toHaveLength(4)
  })
})

describe('a escada é cumulativa — ninguém abre buraco no meio', () => {
  it('tudo que "só olhar" permite, "sugerir" também permite', () => {
    for (const acao of ACOES_NO_REPOSITORIO) {
      if (podeEscrever('so_olhar', acao).pode) {
        expect(podeEscrever('sugerir', acao).pode).toBe(true)
      }
    }
  })

  it('tudo que "sugerir" permite, "cuidar" também permite', () => {
    for (const acao of ACOES_NO_REPOSITORIO) {
      if (podeEscrever('sugerir', acao).pode) {
        expect(podeEscrever('cuidar', acao).pode).toBe(true)
      }
    }
  })

  it('"cuidar" permite tudo — é o topo da escada', () => {
    for (const acao of ACOES_NO_REPOSITORIO) {
      expect(podeEscrever('cuidar', acao).pode).toBe(true)
    }
  })
})

describe('o desconhecido cai no mais restrito, nunca no mais solto', () => {
  // Projeto legado tem a coluna nula. Um `?.` bem-intencionado devolveria
  // `undefined`, que dentro de um `if` vira liberado — o defeito silencioso
  // que esta função existe para não deixar acontecer.
  it('nulo, indefinido e texto desconhecido são todos "só olhar"', () => {
    for (const entrada of [null, undefined, '', 'CUIDAR', 'admin', 'true', 'nivel-novo']) {
      expect(normalizarNivel(entrada)).toBe('so_olhar')
      expect(podeEscrever(entrada as string, 'mesclar').pode).toBe(false)
      expect(podeEscrever(entrada as string, 'ler').pode).toBe(true)
    }
  })

  it('o padrão do produto é o mais restrito', () => {
    expect(NIVEL_PADRAO).toBe('so_olhar')
  })

  it('nome com caixa diferente NÃO passa — é dado do banco, não texto livre', () => {
    expect(podeEscrever('Cuidar', 'mesclar').pode).toBe(false)
  })
})

describe('a recusa diz o que fazer, não só que não', () => {
  it('aponta o nível que resolveria', () => {
    const d = podeEscrever('so_olhar', 'mesclar')
    expect(d.pode).toBe(false)
    if (!d.pode) {
      expect(d.nivelNecessario).toBe('cuidar')
      expect(d.motivo).toContain('mude para')
    }
  })

  it('para organizar o quadro basta "sugerir", não "cuidar"', () => {
    const d = podeEscrever('so_olhar', 'organizar')
    expect(d.pode).toBe(false)
    if (!d.pode) expect(d.nivelNecessario).toBe('sugerir')
  })

  it('o motivo fala a língua do cliente, sem jargão de sistema', () => {
    const d = podeEscrever('so_olhar', 'propor')
    expect(d.motivo).not.toMatch(/undefined|null|enum|boolean|API/i)
    expect(d.motivo.length).toBeGreaterThan(20)
  })

  it('menorNivelQuePermite acha o degrau certo de cada ação', () => {
    expect(menorNivelQuePermite('ler')).toBe('so_olhar')
    expect(menorNivelQuePermite('organizar')).toBe('sugerir')
    expect(menorNivelQuePermite('propor')).toBe('sugerir')
    expect(menorNivelQuePermite('mesclar')).toBe('cuidar')
  })
})

describe('exigirPermissao — a forma usada na porta', () => {
  it('deixa passar quando pode, sem devolver nada para esquecer de olhar', () => {
    expect(() => exigirPermissao('cuidar', 'mesclar')).not.toThrow()
  })

  it('lança o erro TIPADO quando não pode', () => {
    expect(() => exigirPermissao('so_olhar', 'mesclar')).toThrow(EscritaNaoAutorizadaError)
  })

  it('o erro carrega o que o painel precisa mostrar', () => {
    try {
      exigirPermissao('sugerir', 'mesclar')
      throw new Error('devia ter recusado')
    } catch (erro) {
      expect(erro).toBeInstanceOf(EscritaNaoAutorizadaError)
      const e = erro as EscritaNaoAutorizadaError
      expect(e.acao).toBe('mesclar')
      expect(e.nivel).toBe('sugerir')
      expect(e.nivelNecessario).toBe('cuidar')
      expect(e.name).toBe('EscritaNaoAutorizadaError')
    }
  })

  it('a recusa NÃO é um Error genérico — senão viraria "falha de rede" num catch', () => {
    // O mesmo defeito que já custou caro em garantir-sprint.ts: erro sem tipo
    // próprio é indistinguível de falha, e alguém acaba tratando como tal.
    try {
      exigirPermissao('so_olhar', 'organizar')
    } catch (erro) {
      expect((erro as Error).name).not.toBe('Error')
    }
  })
})
