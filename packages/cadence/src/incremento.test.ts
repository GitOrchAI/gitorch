import { describe, it, expect } from 'vitest'
import {
  avaliarPronto,
  normalizarRegua,
  CRITERIOS_DE_PRONTO,
  REGUA_PADRAO,
  O_QUE_FALTA,
  type FatosDaEntrega,
} from './incremento'

// Os estados abaixo são os que `dev_sessions` realmente grava — o vocabulário
// de `deployState` no código é 'no-ar' | 'falhou' | 'publicando' |
// 'sem-publicacao' | 'commit-errado', e o de `envLastVerdict` é 'no-ar' |
// 'inalcancavel'. Nada aqui é inventado.

const NADA: FatosDaEntrega = {
  pullRequestNumber: null,
  mergeCommitSha: null,
  deployState: null,
  envLastVerdict: null,
}

const TUDO: FatosDaEntrega = {
  pullRequestNumber: 42,
  mergeCommitSha: 'deadbeefcafe',
  deployState: 'no-ar',
  envLastVerdict: 'no-ar',
}

describe('avaliarPronto — a régua padrão do produto', () => {
  it('entrega completa passa', () => {
    const v = avaliarPronto(TUDO)
    expect(v.pronto).toBe(true)
    expect(v.faltando).toEqual([])
    expect(v.porQueNaoFechou).toEqual([])
  })

  it('pedido sem entrega nenhuma não está pronto, e diz o que falta', () => {
    const v = avaliarPronto(NADA)
    expect(v.pronto).toBe(false)
    expect(v.faltando).toContain('entregou')
    expect(v.porQueNaoFechou[0]).toBe(O_QUE_FALTA.entregou)
  })

  it('mesclado mas NÃO no ar: não está pronto — a regra do dono', () => {
    // "Só considero que evoluiu quando foi testado em produção real."
    const v = avaliarPronto({ ...TUDO, deployState: 'sem-publicacao' })
    expect(v.pronto).toBe(false)
    expect(v.faltando).toEqual(['no_ar'])
    expect(v.porQueNaoFechou).toEqual(['foi mesclada, mas ainda não chegou ao ar'])
  })

  it('"publicando" NÃO conta como no ar — está a caminho, não chegou', () => {
    // Contar o caminho como chegada faria o painel dizer "entregue" enquanto o
    // cliente ainda não consegue usar.
    expect(avaliarPronto({ ...TUDO, deployState: 'publicando' }).pronto).toBe(false)
  })

  it('publicação que FALHOU não está pronta', () => {
    expect(avaliarPronto({ ...TUDO, deployState: 'falhou' }).pronto).toBe(false)
  })

  it('o ambiente vem DESLIGADO no padrão — não se cobra o que o cliente não declarou', () => {
    // Sem endereço de ambiente configurado, `envLastVerdict` é nulo para
    // sempre. Cobrar isso por padrão transformaria TODA entrega em "faltando".
    expect(REGUA_PADRAO.ambiente_respondeu).toBe(false)
    const v = avaliarPronto({ ...TUDO, envLastVerdict: null })
    expect(v.pronto).toBe(true)
    expect(v.faltando).not.toContain('ambiente_respondeu')
  })
})

describe('a régua é do cliente — ligar e desligar muda o resultado', () => {
  const MESCLADO_SEM_AR: FatosDaEntrega = {
    ...TUDO,
    deployState: 'sem-publicacao',
    envLastVerdict: null,
  }

  it('desligar "no ar" faz a MESMA entrega passar', () => {
    expect(avaliarPronto(MESCLADO_SEM_AR).pronto).toBe(false)
    expect(avaliarPronto(MESCLADO_SEM_AR, { ...REGUA_PADRAO, no_ar: false }).pronto).toBe(true)
  })

  it('ligar o ambiente faz a MESMA entrega parar de passar', () => {
    expect(avaliarPronto(TUDO).pronto).toBe(true)
    const exigente = { ...REGUA_PADRAO, ambiente_respondeu: true }
    expect(avaliarPronto({ ...TUDO, envLastVerdict: null }, exigente).pronto).toBe(false)
  })

  it('critério DESLIGADO não entra nem em atendidos nem em faltando', () => {
    // Desligar é dizer "isto não faz parte da minha régua", e não "considere
    // que passou".
    const v = avaliarPronto(TUDO, { entregou: true })
    expect(v.atendidos).toEqual(['entregou'])
    expect(v.faltando).toEqual([])
    expect(CRITERIOS_DE_PRONTO.length).toBeGreaterThan(1)
  })

  it('régua VAZIA não deixa nada pronto — não é verdade por vacuidade', () => {
    // Régua sem critério nenhum significa que o cliente ainda não disse o que
    // é pronto para ele. O produto não tem o direito de afirmar que algo está.
    const v = avaliarPronto(TUDO, {})
    expect(v.pronto).toBe(false)
  })

  it('a ordem do que falta é a ordem da régua, não a de chegada', () => {
    const v = avaliarPronto(NADA, {
      entregou: true,
      mesclado: true,
      no_ar: true,
      ambiente_respondeu: true,
    })
    expect(v.faltando).toEqual(['entregou', 'mesclado', 'no_ar', 'ambiente_respondeu'])
  })
})

describe('normalizarRegua — o que não se reconhece nunca vira permissão', () => {
  it('chave faltando cai no padrão', () => {
    expect(normalizarRegua({ no_ar: false })).toEqual({ ...REGUA_PADRAO, no_ar: false })
  })

  it('chave desconhecida é descartada', () => {
    const r = normalizarRegua({ inventado: true, no_ar: true })
    expect(r).toEqual(REGUA_PADRAO)
    expect('inventado' in r).toBe(false)
  })

  it('valor que não é booleano é ignorado — "sim" não liga critério', () => {
    expect(normalizarRegua({ no_ar: 'sim' })).toEqual(REGUA_PADRAO)
    expect(normalizarRegua({ no_ar: 1 })).toEqual(REGUA_PADRAO)
  })

  it('nulo, lista e texto viram o padrão em vez de estourar', () => {
    for (const entrada of [null, undefined, [], 'regua', 42]) {
      expect(normalizarRegua(entrada)).toEqual(REGUA_PADRAO)
    }
  })
})
