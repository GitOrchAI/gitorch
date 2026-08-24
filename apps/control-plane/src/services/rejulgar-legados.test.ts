import { describe, it, expect } from 'vitest'
import {
  decidirSobreLegado,
  trocarLegadosPorRejulgamento,
  REGUA_MUDOU_EM,
  type EntregaPresa,
} from './rejulgar-legados.js'

const ANTES = new Date(REGUA_MUDOU_EM.getTime() - 24 * 60 * 60 * 1000)
const DEPOIS = new Date(REGUA_MUDOU_EM.getTime() + 60 * 1000)

function presa(over: Partial<EntregaPresa> = {}): EntregaPresa {
  return {
    numero: 3768,
    headAtual: 'abc123',
    headJulgado: 'abc123',
    reprovadaEm: ANTES,
    ciHoje: 'green',
    delegada: true,
    jaRejulgada: false,
    ...over,
  }
}

describe('decidirSobreLegado', () => {
  // Os três PRs reais do patinhas: CI 100% verde, mergeStateStatus CLEAN, e
  // presos por uma reprovação escrita quando `skipped` contava como falha.
  it('rejulga a entrega reprovada pela régua velha que hoje está verde', () => {
    const d = decidirSobreLegado(presa())
    expect(d.acao).toBe('rejulgar')
    expect(d.motivo).toMatch(/antes da correção/i)
  })

  // Este é o limite que impede o caminho de virar segunda chance permanente.
  it('reprovação POSTERIOR ao corte não ganha nada', () => {
    const d = decidirSobreLegado(presa({ reprovadaEm: DEPOIS }))
    expect(d.acao).toBe('deixar')
    expect(d.motivo).toMatch(/régua de hoje/i)
  })

  it('exatamente no instante do corte já conta como régua nova', () => {
    expect(decidirSobreLegado(presa({ reprovadaEm: REGUA_MUDOU_EM })).acao).toBe('deixar')
  })

  // Se o dev empurrou commit depois da reprovação, o caminho normal já reabre —
  // e rejulgar aqui seria opinar sobre um código que ninguém reprovou.
  it('código que mudou desde a reprovação fica com o caminho normal', () => {
    const d = decidirSobreLegado(presa({ headJulgado: 'antigo', headAtual: 'novo' }))
    expect(d.acao).toBe('deixar')
    expect(d.motivo).toMatch(/o código mudou/i)
  })

  it('sem saber sobre qual commit foi a reprovação, não mexe', () => {
    expect(decidirSobreLegado(presa({ headJulgado: null }).valueOf() as EntregaPresa).acao).toBe(
      'deixar'
    )
  })

  // A evidência inteira é o CI verde HOJE. Sem ela não há nada que diga que a
  // reprovação foi da régua velha e não do mérito do código.
  it.each(['red', 'pending', 'no checks', 'unknown'] as const)(
    'verificação "%s" pela régua de hoje não rejulga',
    (ciHoje) => {
      const d = decidirSobreLegado(presa({ ciHoje }))
      expect(d.acao).toBe('deixar')
      expect(d.motivo).toContain(ciHoje)
    }
  )

  // A MESMA regra do julgamento normal, e ela não afrouxa aqui: entrega que o
  // produto não encomendou não é nossa para mesclar.
  it('entrega de humano continua fora', () => {
    const d = decidirSobreLegado(presa({ delegada: false }))
    expect(d.acao).toBe('deixar')
    expect(d.motivo).toMatch(/não foi o produto/i)
  })

  // UMA vez. Senão um PR vermelho por mérito seria reaberto a cada varredura,
  // virando opinião repetida no pull request do cliente.
  it('o rejulgamento é de cortesia e acontece UMA vez', () => {
    const d = decidirSobreLegado(presa({ jaRejulgada: true }))
    expect(d.acao).toBe('deixar')
    expect(d.motivo).toMatch(/já recebeu/i)
  })

  it('data de reprovação ilegível não vira rejulgamento', () => {
    expect(decidirSobreLegado(presa({ reprovadaEm: new Date('nada') })).acao).toBe('deixar')
    expect(decidirSobreLegado(presa({ reprovadaEm: null })).acao).toBe('deixar')
  })
})

describe('trocarLegadosPorRejulgamento', () => {
  it('separa quem entra de quem fica, e diz o porquê de cada um', () => {
    const r = trocarLegadosPorRejulgamento([
      presa({ numero: 3768 }),
      presa({ numero: 3758 }),
      presa({ numero: 3762, ciHoje: 'red' }),
      presa({ numero: 999, delegada: false }),
    ])
    expect(r.rejulgar).toEqual([3768, 3758])
    expect(r.deixadas.map((d) => d.numero)).toEqual([3762, 999])
    expect(r.deixadas[0]?.motivo).toContain('red')
  })

  it('lista vazia não quebra', () => {
    expect(trocarLegadosPorRejulgamento([])).toEqual({ rejulgar: [], deixadas: [] })
  })
})

// A fiação real, e não só a régua: os testes acima provam a decisão isolada,
// e a revisão pegou que nenhum deles garantia que o QA CHEGA a chamá-la com os
// valores certos. Estes cobrem o contrato que a fiação precisa cumprir.
describe('o contrato que a fiação tem de respeitar', () => {
  // O QA passa o commit sobre o qual a REVIEW foi escrita (`commit_id`), não o
  // head de agora. Passando o head dos dois lados, este ramo nunca dispararia
  // e a proteção existiria só no papel.
  it('o commit julgado vem da review, então código novo bloqueia o rejulgamento', () => {
    const dev = decidirSobreLegado(presa({ headJulgado: 'sha_da_review', headAtual: 'sha_novo' }))
    expect(dev.acao).toBe('deixar')
    expect(dev.motivo).toMatch(/o código mudou/i)
  })

  // `delegada` tem de vir do veredito real. Com `true` fixo, a regra do dono
  // ("só mescla o que o produto encomendou") viraria enfeite neste caminho.
  it('entrega não delegada é recusada mesmo com todo o resto perfeito', () => {
    const humana = presa({ delegada: false, ciHoje: 'green', reprovadaEm: ANTES })
    expect(decidirSobreLegado(humana).acao).toBe('deixar')
  })

  // O corte é o DEPLOY, não o merge: entre um e outro o processo ainda roda o
  // binário velho. Uma reprovação nessa janela foi julgada pela régua antiga.
  it('o corte é depois do reinício observado, com folga', () => {
    const reinicioObservado = new Date('2026-08-24T04:29:00Z')
    expect(REGUA_MUDOU_EM.getTime()).toBeGreaterThan(reinicioObservado.getTime())
    const naJanelaEntreMergeEDeploy = presa({ reprovadaEm: new Date('2026-08-24T04:40:00Z') })
    expect(decidirSobreLegado(naJanelaEntreMergeEDeploy).acao).toBe('rejulgar')
  })
})
