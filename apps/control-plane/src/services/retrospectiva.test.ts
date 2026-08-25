import { describe, expect, it } from 'vitest'
import { medirRetrospectiva, escolherAMelhoria } from './retrospectiva.js'

// A retrospectiva do Scrum — a parte do método que olha para TRÁS.
//
// O produto tinha o evento escrito e nunca ligado: o playbook
// `packages/cadence/playbooks/events/sprint-retro.md` existe completo, o tipo
// `CadenceEvent` já inclui 'sprint-retro', e o playbook nomeia as quatro
// medidas certas. Mas `loadEventPlaybook('sprint-retro')` só era chamado num
// teste, e a agenda padrão só tinha ra, po, sm e qa.
//
// O resultado é que o ciclo só olhava para frente. Uma entrega falhava, o QA
// reprovava, e nada disso mudava o ciclo seguinte: nem o pedido ao dev, nem o
// critério de aceitação, nem a cadência. Cada falha morria isolada.
//
// Este módulo é a metade que faltava, e é PURO de propósito: recebe as linhas
// já lidas e devolve o retrato. Sem banco, sem rede, sem relógio próprio — é o
// que permite testar o retrato com números difíceis sem precisar produzi-los
// de verdade.

const FIM = new Date('2026-08-23T00:00:00Z')

function sessao(over: Partial<Parameters<typeof medirRetrospectiva>[0]['sessoes'][number]> = {}) {
  return {
    sessionName: 'sessions/1',
    closedReason: 'merged' as string | null,
    nudges: 0,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    closedAt: new Date('2026-08-20T01:00:00Z') as Date | null,
    ...over,
  }
}

describe('medirRetrospectiva', () => {
  it('conta entregas que chegaram e entregas abandonadas', () => {
    const r = medirRetrospectiva({
      sessoes: [
        sessao({ closedReason: 'merged' }),
        sessao({ closedReason: 'merged' }),
        sessao({ closedReason: 'abandoned' }),
      ],
      missoes: [],
      fim: FIM,
    })
    expect(r.entregasMescladas).toBe(2)
    expect(r.entregasAbandonadas).toBe(1)
    expect(r.taxaDeAbandono).toBeCloseTo(1 / 3)
  })

  it('sessão AINDA ABERTA não entra na taxa de abandono', () => {
    // Contá-la como abandonada seria condenar trabalho em andamento, e o
    // número da retrospectiva viraria pessimismo em vez de medida.
    const r = medirRetrospectiva({
      sessoes: [sessao({ closedReason: null, closedAt: null }), sessao({ closedReason: 'merged' })],
      missoes: [],
      fim: FIM,
    })
    expect(r.entregasMescladas).toBe(1)
    expect(r.entregasAbandonadas).toBe(0)
    expect(r.taxaDeAbandono).toBe(0)
  })

  it('mede quantas entregas precisaram de empurrão para não travar', () => {
    const r = medirRetrospectiva({
      sessoes: [sessao({ nudges: 0 }), sessao({ nudges: 1 }), sessao({ nudges: 5 })],
      missoes: [],
      fim: FIM,
    })
    expect(r.sessoesQuePrecisaramDeEmpurrao).toBe(2)
    expect(r.taxaDeEmpurrao).toBeCloseTo(2 / 3)
  })

  it('mede as acordadas em falso por papel — é aí que a cota some', () => {
    const r = medirRetrospectiva({
      sessoes: [],
      missoes: [
        { type: 'agent-run-qa', noOp: true },
        { type: 'agent-run-qa', noOp: true },
        { type: 'agent-run-qa', noOp: false },
        { type: 'agent-run-sm', noOp: false },
      ],
      fim: FIM,
    })
    expect(r.acordadasEmFalsoPorPapel['qa']).toEqual({ total: 3, emFalso: 2 })
    expect(r.acordadasEmFalsoPorPapel['sm']).toEqual({ total: 1, emFalso: 0 })
  })

  it('mede quanto tempo uma entrega leva do começo ao fim', () => {
    const r = medirRetrospectiva({
      sessoes: [
        sessao({
          createdAt: new Date('2026-08-20T00:00:00Z'),
          closedAt: new Date('2026-08-20T02:00:00Z'),
        }),
        sessao({
          createdAt: new Date('2026-08-20T00:00:00Z'),
          closedAt: new Date('2026-08-20T04:00:00Z'),
        }),
      ],
      missoes: [],
      fim: FIM,
    })
    expect(r.horasMedianasAteFechar).toBe(3)
  })

  it('PERÍODO SEM DADO devolve o retrato vazio, e DIZ que está vazio', () => {
    // A regra que o dono escreveu na tarefa: número que não existe é dito, não
    // estimado. Um retrato vazio apresentado como se fosse medição faria a
    // retrospectiva mentir logo na primeira semana de um projeto novo.
    const r = medirRetrospectiva({ sessoes: [], missoes: [], fim: FIM })
    expect(r.semDados).toBe(true)
    expect(r.taxaDeAbandono).toBeNull()
    expect(r.horasMedianasAteFechar).toBeNull()
  })

  it('com dados, nunca diz que está sem dados', () => {
    const r = medirRetrospectiva({ sessoes: [sessao()], missoes: [], fim: FIM })
    expect(r.semDados).toBe(false)
  })
})

describe('escolherAMelhoria', () => {
  it('escolhe UMA, e escolhe a que mais dói', () => {
    // O playbook pede UMA melhoria concreta, pequena o bastante para
    // acontecer. Escolher três é escolher nenhuma.
    const r = medirRetrospectiva({
      sessoes: [sessao({ closedReason: 'abandoned' }), sessao({ closedReason: 'abandoned' })],
      missoes: [
        { type: 'agent-run-qa', noOp: true },
        { type: 'agent-run-qa', noOp: true },
      ],
      fim: FIM,
    })
    const escolha = escolherAMelhoria(r)
    expect(escolha).not.toBeNull()
    expect(escolha!.area).toBeTypeOf('string')
    expect(escolha!.porque).toContain('%')
  })

  it('período saudável NÃO inventa melhoria', () => {
    // Inventar uma melhoria num período bom é o jeito mais rápido de a
    // retrospectiva virar ruído que ninguém lê.
    const r = medirRetrospectiva({
      sessoes: [sessao(), sessao(), sessao()],
      missoes: [{ type: 'agent-run-qa', noOp: false }],
      fim: FIM,
    })
    expect(escolherAMelhoria(r)).toBeNull()
  })

  it('sem dados NÃO escolhe nada — não há o que melhorar sem medida', () => {
    const r = medirRetrospectiva({ sessoes: [], missoes: [], fim: FIM })
    expect(escolherAMelhoria(r)).toBeNull()
  })

  it('a escolha carrega o NÚMERO que a justifica, não um adjetivo', () => {
    // "o QA está acordando à toa" não é acionável. "93% das acordadas do QA
    // não tinham nada para julgar" é.
    const r = medirRetrospectiva({
      sessoes: [sessao()],
      missoes: Array.from({ length: 10 }, (_, i) => ({
        type: 'agent-run-qa',
        noOp: i < 9,
      })),
      fim: FIM,
    })
    const escolha = escolherAMelhoria(r)
    expect(escolha!.porque).toMatch(/90/)
  })
})

describe('a reserva de vaga não envenena a medida', () => {
  // A reserva nasce e morre em segundos quando o dev externo recusa, sem nunca
  // ter sido tocada. Contá-la como entrega abandonada inflaria a taxa de
  // abandono justamente porque o produto passou a recusar CEDO.
  it('reserva recusada não conta como entrega abandonada', () => {
    const r = medirRetrospectiva({
      sessoes: [
        sessao({ closedReason: 'merged' }),
        sessao({ sessionName: 'reserva/proj/153', closedReason: 'failed_final' }),
        sessao({ sessionName: 'reserva/proj/155', closedReason: 'failed_final' }),
      ],
      missoes: [],
      fim: FIM,
    })
    expect(r.entregasAbandonadas).toBe(0)
    expect(r.entregasMescladas).toBe(1)
  })

  it('trabalho abandonado de verdade continua contando', () => {
    const r = medirRetrospectiva({
      sessoes: [
        sessao({ sessionName: 'sessions/999', closedReason: 'abandoned' }),
        sessao({ sessionName: 'reserva/proj/1', closedReason: 'failed_final' }),
      ],
      missoes: [],
      fim: FIM,
    })
    expect(r.entregasAbandonadas).toBe(1)
  })
})
