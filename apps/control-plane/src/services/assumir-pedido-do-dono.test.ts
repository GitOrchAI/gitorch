import { describe, expect, it } from 'vitest'
import {
  ESPERA_PADRAO_DO_DONO_HORAS,
  MARCA_NAO_MEXER,
  VARIAVEL_DA_ESPERA_DO_DONO,
  deveAssumirPedidoDoDono,
  ehContaDoDono,
  lerEsperaDoDonoMs,
  temMarcaNaoMexer,
  ultimoMovimentoReal,
} from './assumir-pedido-do-dono.js'

const HORA = 60 * 60 * 1000
const AGORA = new Date('2026-03-10T12:00:00.000Z')
const haHoras = (h: number): Date => new Date(AGORA.getTime() - h * HORA)

function base(sobrepor: Partial<Parameters<typeof deveAssumirPedidoDoDono>[0]> = {}) {
  return {
    autonomia: 'cuidar',
    autorEhDono: true,
    marcaNaoMexer: false,
    ultimoMovimentoReal: haHoras(25) as Date | null,
    agora: AGORA,
    motivoParado: 'qa-reprovou' as const,
    retomadasFeitas: 0,
    teto: 1,
    ...sobrepor,
  }
}

describe('deveAssumirPedidoDoDono', () => {
  it('a espera padrão é de 24 horas', () => {
    expect(ESPERA_PADRAO_DO_DONO_HORAS).toBe(24)
  })

  it('23 horas parado: espera, dizendo quando assume', () => {
    const r = deveAssumirPedidoDoDono(base({ ultimoMovimentoReal: haHoras(23) }))
    expect(r).toEqual({ decisao: 'espera', assumeEm: new Date(AGORA.getTime() + HORA) })
  })

  it('25 horas parado: assume, com o motivo que parou o PR', () => {
    expect(deveAssumirPedidoDoDono(base())).toEqual({ decisao: 'assume', causa: 'qa-reprovou' })
  })

  it('exatamente 24 horas: assume', () => {
    const r = deveAssumirPedidoDoDono(base({ ultimoMovimentoReal: haHoras(24) }))
    expect(r.decisao).toBe('assume')
  })

  it('marca de não mexer impede, mesmo depois de dias', () => {
    const r = deveAssumirPedidoDoDono(
      base({ marcaNaoMexer: true, ultimoMovimentoReal: haHoras(99) })
    )
    expect(r).toEqual({ decisao: 'nao-e-o-caso', razao: 'marcado-nao-mexer' })
  })

  it('teto de retomadas impede', () => {
    const r = deveAssumirPedidoDoDono(base({ retomadasFeitas: 1, teto: 1 }))
    expect(r).toEqual({ decisao: 'nao-e-o-caso', razao: 'teto-de-retomadas' })
  })

  it('sem motivo para estar parado, não é o caso', () => {
    const r = deveAssumirPedidoDoDono(base({ motivoParado: null }))
    expect(r).toEqual({ decisao: 'nao-e-o-caso', razao: 'sem-motivo' })
  })

  it('autor que não é o dono, não é o caso', () => {
    const r = deveAssumirPedidoDoDono(base({ autorEhDono: false }))
    expect(r).toEqual({ decisao: 'nao-e-o-caso', razao: 'autor-nao-e-o-dono' })
  })

  it('so_olhar não faz nada', () => {
    const r = deveAssumirPedidoDoDono(base({ autonomia: 'so_olhar' }))
    expect(r).toEqual({ decisao: 'nao-e-o-caso', razao: 'autonomia-nao-permite' })
  })

  it('autonomia desconhecida não faz nada', () => {
    const r = deveAssumirPedidoDoDono(base({ autonomia: 'qualquer' }))
    expect(r.decisao).toBe('nao-e-o-caso')
  })

  it('sugerir nunca assume: passada a espera, só pergunta', () => {
    const r = deveAssumirPedidoDoDono(base({ autonomia: 'sugerir' }))
    expect(r).toEqual({ decisao: 'pergunta', causa: 'qa-reprovou' })
  })

  it('sugerir antes da espera não toca em nada', () => {
    const r = deveAssumirPedidoDoDono(
      base({ autonomia: 'sugerir', ultimoMovimentoReal: haHoras(2) })
    )
    expect(r.decisao).toBe('nao-e-o-caso')
  })

  it('sem saber o último movimento, não assume (não dá para provar a espera)', () => {
    const r = deveAssumirPedidoDoDono(base({ ultimoMovimentoReal: null }))
    expect(r).toEqual({ decisao: 'nao-e-o-caso', razao: 'movimento-desconhecido' })
  })

  it('a espera configurada vale no lugar da padrão', () => {
    const r = deveAssumirPedidoDoDono(base({ ultimoMovimentoReal: haHoras(7), esperaMs: 6 * HORA }))
    expect(r.decisao).toBe('assume')
  })
})

describe('lerEsperaDoDonoMs', () => {
  it('padrão de 24 horas sem variável', () => {
    expect(lerEsperaDoDonoMs({})).toBe(24 * HORA)
  })
  it('lê a variável de ambiente, em horas', () => {
    expect(lerEsperaDoDonoMs({ [VARIAVEL_DA_ESPERA_DO_DONO]: '48' })).toBe(48 * HORA)
  })
  it('valor inválido cai no padrão', () => {
    expect(lerEsperaDoDonoMs({ [VARIAVEL_DA_ESPERA_DO_DONO]: 'abc' })).toBe(24 * HORA)
    expect(lerEsperaDoDonoMs({ [VARIAVEL_DA_ESPERA_DO_DONO]: '0' })).toBe(24 * HORA)
    expect(lerEsperaDoDonoMs({ [VARIAVEL_DA_ESPERA_DO_DONO]: '-3' })).toBe(24 * HORA)
  })
})

describe('ehContaDoDono', () => {
  it('compara o login sem diferenciar maiúsculas', () => {
    expect(ehContaDoDono('Dono-Da-Conta', 'dono-da-conta')).toBe(true)
  })
  it('outro login não é o dono', () => {
    expect(ehContaDoDono('colaborador', 'dono-da-conta')).toBe(false)
  })
  it('sem login do dono ou sem autor, ninguém é o dono', () => {
    expect(ehContaDoDono('dono-da-conta', null)).toBe(false)
    expect(ehContaDoDono(null, 'dono-da-conta')).toBe(false)
    expect(ehContaDoDono('dono-da-conta', '')).toBe(false)
  })
  it('conta de robô nunca é o dono', () => {
    expect(ehContaDoDono('app[bot]', 'app[bot]')).toBe(false)
  })
})

describe('temMarcaNaoMexer', () => {
  it('reconhece o rótulo combinado', () => {
    expect(MARCA_NAO_MEXER).toBe('gitorch:nao-mexer')
    expect(temMarcaNaoMexer(['bug', 'gitorch:nao-mexer'])).toBe(true)
  })
  it('sem o rótulo, sem marca', () => {
    expect(temMarcaNaoMexer(['bug'])).toBe(false)
    expect(temMarcaNaoMexer(null)).toBe(false)
    expect(temMarcaNaoMexer(undefined)).toBe(false)
  })
})

describe('ultimoMovimentoReal', () => {
  const commit = haHoras(30)

  it('sem mais nada, é o commit', () => {
    expect(ultimoMovimentoReal({ ultimoCommitEm: commit, interacoes: [] })).toEqual(commit)
  })

  it('comentário de pessoa depois do commit é o movimento', () => {
    const r = ultimoMovimentoReal({
      ultimoCommitEm: commit,
      interacoes: [{ quando: haHoras(5).toISOString(), login: 'colega', corpo: 'olhei aqui' }],
    })
    expect(r).toEqual(haHoras(5))
  })

  it('parecer do produto (marca no corpo) não conta como movimento', () => {
    const r = ultimoMovimentoReal({
      ultimoCommitEm: commit,
      interacoes: [
        { quando: haHoras(1).toISOString(), login: 'dono', corpo: '<!-- gitorch:qa -->\nparecer' },
      ],
    })
    expect(r).toEqual(commit)
  })

  it('robô (login terminado em [bot] ou tipo Bot) não conta', () => {
    const r = ultimoMovimentoReal({
      ultimoCommitEm: commit,
      interacoes: [
        { quando: haHoras(1).toISOString(), login: 'github-actions[bot]', corpo: 'conflito' },
        { quando: haHoras(2).toISOString(), login: 'outra', tipo: 'Bot', corpo: 'x' },
      ],
    })
    expect(r).toEqual(commit)
  })

  it('sem data do commit não há como provar o movimento', () => {
    expect(ultimoMovimentoReal({ ultimoCommitEm: null, interacoes: [] })).toBeNull()
  })

  it('data ilegível é ignorada', () => {
    const r = ultimoMovimentoReal({
      ultimoCommitEm: commit,
      interacoes: [{ quando: 'ontem', login: 'colega', corpo: 'x' }],
    })
    expect(r).toEqual(commit)
  })
})
