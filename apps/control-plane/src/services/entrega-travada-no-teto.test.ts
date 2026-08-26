import { describe, it, expect } from 'vitest'
import {
  chaveDoResgate,
  decidirResgateDaTravada,
  pedidoDeResgate,
} from './entrega-travada-no-teto.js'
import { MAX_TENTATIVAS_DE_MERGE } from './qa-rails-mission.js'

const NO_TETO = MAX_TENTATIVAS_DE_MERGE

describe('decidirResgateDaTravada — o PR que bateu o teto e nunca mais foi tentado', () => {
  it('entrega delegada no teto, com sessão viva: pede o resgate', () => {
    // O beco medido em 26/08: #213 e #194, APROVADOS pelo QA, com
    // mergeFailures = 3. O laço de descoberta os pula para sempre, então a
    // tentativa de merge nunca mais roda — e é só DENTRO dela que o conflito
    // seria mandado ao dev. Ninguém pede rebase, o commit nunca muda, o teto
    // nunca zera. Parados desde 15 e 21/08.
    const d = decidirResgateDaTravada({
      delegado: true,
      mergeFailures: NO_TETO,
      temSessaoViva: true,
      jaPediuNesteHead: false,
    })
    expect(d.resgatar).toBe(true)
  })

  it('ainda ABAIXO do teto: não se mete — o caminho normal ainda vai tentar', () => {
    const d = decidirResgateDaTravada({
      delegado: true,
      mergeFailures: NO_TETO - 1,
      temSessaoViva: true,
      jaPediuNesteHead: false,
    })
    expect(d.resgatar).toBe(false)
  })

  it('PR que não é nosso: nunca — não se mexe em trabalho alheio', () => {
    const d = decidirResgateDaTravada({
      delegado: false,
      mergeFailures: NO_TETO,
      temSessaoViva: true,
      jaPediuNesteHead: false,
    })
    expect(d.resgatar).toBe(false)
  })

  it('sessão do dev já encerrada: não há a quem pedir — vira aviso ao dono', () => {
    const d = decidirResgateDaTravada({
      delegado: true,
      mergeFailures: NO_TETO,
      temSessaoViva: false,
      jaPediuNesteHead: false,
    })
    expect(d.resgatar).toBe(false)
    if (d.resgatar) return
    expect(d.avisarDono).toBe(true)
  })

  it('já pedimos neste mesmo commit: não repete a cada tique', () => {
    const d = decidirResgateDaTravada({
      delegado: true,
      mergeFailures: NO_TETO,
      temSessaoViva: true,
      jaPediuNesteHead: true,
    })
    expect(d.resgatar).toBe(false)
    // E não vira spam para o dono também.
    if (d.resgatar) return
    expect(d.avisarDono).toBe(false)
  })

  it('acima do teto continua valendo — não é só a igualdade exata', () => {
    const d = decidirResgateDaTravada({
      delegado: true,
      mergeFailures: NO_TETO + 4,
      temSessaoViva: true,
      jaPediuNesteHead: false,
    })
    expect(d.resgatar).toBe(true)
  })
})

describe('chaveDoResgate e pedidoDeResgate', () => {
  it('a marca leva o COMMIT — commit novo faz o resgate valer de novo', () => {
    expect(chaveDoResgate('abc123')).not.toBe(chaveDoResgate('def456'))
    // E é isso que se quer: com commit novo, o conflito é outro.
    const d = decidirResgateDaTravada({
      delegado: true,
      mergeFailures: NO_TETO,
      temSessaoViva: true,
      jaPediuNesteHead: chaveDoResgate('def456') === chaveDoResgate('abc123'),
    })
    expect(d.resgatar).toBe(true)
  })

  it('sem commit conhecido a marca ainda é estável — não vira pedido a cada tique', () => {
    expect(chaveDoResgate(null)).toBe(chaveDoResgate(null))
  })

  it('o pedido diz o que aconteceu, o que fazer e o que NÃO fazer', () => {
    const p = pedidoDeResgate(213)
    expect(p).toContain('#213')
    expect(p).toMatch(/rebase|merge da principal/i)
    // O limite importa tanto quanto a instrução: dev que sai do escopo cria
    // um problema novo enquanto resolve o antigo.
    expect(p).toMatch(/fora do escopo/i)
    // E a promessa de volta, para ele saber que vale a pena empurrar.
    expect(p).toMatch(/commit novo/i)
  })
})
