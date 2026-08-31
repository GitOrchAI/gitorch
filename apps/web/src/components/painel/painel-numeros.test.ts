import { describe, test, expect } from 'vitest'
import {
  kpisDaVisaoGeral,
  contadoresDoProjeto,
  PALAVRAS_DE_ENTREGA,
  type KpiView,
} from './painel-numeros'

// Os números são os MEDIDOS no banco de produção do dono em 31/08/2026:
//
//   select status, count(*) from missions group by status;
//     completed | 4521
//     failed    |  477
//
//   select count(*), count(distinct issue_number) from dev_sessions;
//     200 | 99
//   -- 15 pedidos passam na régua padrão (gitorch 1 de 58, patinhas 14 de 41)
//
// O painel anunciava "Entregue no total: 4521" lendo o primeiro. A verdade
// pela régua do dono é 15 entregas em 99 pedidos. É essa distância — de duas
// ordens de grandeza — que os testes abaixo travam.
const RODADAS = { active: 3, completed: 4521, failed: 477 }
const ENTREGAS = { prontas: 15, total: 99 }

const acharPorRotulo = (kpis: KpiView[], rotulo: string): KpiView => {
  const k = kpis.find((x) => x.l === rotulo)
  if (!k)
    throw new Error(
      `nenhum KPI com o rótulo "${rotulo}" — rótulos: ${kpis.map((x) => x.l).join(' | ')}`
    )
  return k
}

describe('kpisDaVisaoGeral — entrega é incremento, nunca rodada de agente', () => {
  test('"Entregue no total" mostra as entregas prontas pela régua, não as rodadas concluídas', () => {
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 0 })

    expect(acharPorRotulo(kpis, 'Entregue no total').v).toBe(15)
  })

  test('o contador de rodadas concluídas NÃO aparece em nenhum número da tela', () => {
    // Mesmo que alguém troque o rótulo mais tarde, 4521 não pode reaparecer
    // em lugar nenhum da Visão Geral.
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 0 })

    expect(kpis.map((k) => k.v)).not.toContain(RODADAS.completed)
  })

  test('o denominador é o de PEDIDOS — 99 —, não o de sessões', () => {
    // O cartão da aba Entregas diz "Pedido #N". O denominador tem que ser da
    // mesma unidade, ou o dono lê duzentos pedidos onde há noventa e nove.
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 0 })
    const n = acharPorRotulo(kpis, 'Entregue no total').n

    expect(n).toContain('99')
    expect(n).not.toContain('200')
  })

  test('entregas ainda carregando → travessão (null), nunca o número das rodadas', () => {
    const kpis = kpisDaVisaoGeral({ entregas: null, rodadas: RODADAS, decisoesPendentes: 0 })

    expect(acharPorRotulo(kpis, 'Entregue no total').v).toBeNull()
  })

  test('total ausente na resposta NÃO vira "de 0" ao lado de um número real', () => {
    // O default vazio que já nos custou caro: `?? 0` escreveria "de 0 que
    // passaram pela sua régua" embaixo de um 15 verdadeiro.
    const kpis = kpisDaVisaoGeral({
      entregas: { prontas: 15, total: null },
      rodadas: RODADAS,
      decisoesPendentes: 0,
    })
    const k = acharPorRotulo(kpis, 'Entregue no total')

    expect(k.v).toBe(15)
    expect(k.n).not.toContain('de 0')
  })

  test('as 477 falhas continuam visíveis, mas com o nome do que são: rodada de agente', () => {
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 0 })
    const falhas = kpis.filter((k) => k.v === RODADAS.failed)

    expect(falhas).toHaveLength(1)
    expect(falhas[0]!.l.toLowerCase()).toContain('rodada')
  })

  test('nenhum número vindo de rodada de agente usa palavra de entrega no rótulo ou na nota', () => {
    // A REGRA GERAL, executável: número com nome de negócio não pode ser
    // alimentado por contador interno. Vale para rótulo E nota — a nota
    // "precisa de revisão manual" mandava o dono revisar entrega que não existe.
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 4 })

    for (const k of kpis.filter((x) => x.fonte === 'rodadas')) {
      expect(`${k.l} · ${k.n}`).not.toMatch(PALAVRAS_DE_ENTREGA)
    }
  })

  test('a nota das falhas não manda mais revisar entrega nenhuma', () => {
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 0 })
    const falhas = kpis.filter((k) => k.v === RODADAS.failed)[0]!

    expect(falhas.n).not.toContain('revisão manual')
  })

  test('sem falha nenhuma, a nota fala de rodada e não de entrega parada', () => {
    const kpis = kpisDaVisaoGeral({
      entregas: ENTREGAS,
      rodadas: { ...RODADAS, failed: 0 },
      decisoesPendentes: 0,
    })

    expect(
      kpis
        .filter((k) => k.fonte === 'rodadas')
        .map((k) => k.n)
        .join(' ')
    ).not.toMatch(PALAVRAS_DE_ENTREGA)
  })

  test('"Esperando sua decisão" continua contando decisões de verdade', () => {
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 4 })
    const d = acharPorRotulo(kpis, 'Esperando sua decisão')

    expect(d.v).toBe(4)
    expect(d.destaque).toBe(true)
  })

  test('a Visão Geral e a aba Entregas mostram o MESMO número de prontas', () => {
    // As duas telas leem a mesma rota. Era por lerem fontes diferentes que a
    // mesma tela dizia "Entregue no total: 4439" no topo e "PRONTAS: 0" ao lado.
    const kpis = kpisDaVisaoGeral({ entregas: ENTREGAS, rodadas: RODADAS, decisoesPendentes: 0 })

    expect(acharPorRotulo(kpis, 'Entregue no total').v).toBe(ENTREGAS.prontas)
  })
})

describe('contadoresDoProjeto — 3671 é rodada de agente, não tarefa', () => {
  // Medido em 31/08/2026:
  //   select p.name, count(m.id) from projects p left join missions m
  //     on m.project_id = p.id group by 1;
  //     gitorch            | 3671
  //     patinhas-3d-crafts | 1327
  test('o cartão mostra o número, com o rótulo do que ele realmente é', () => {
    const c = contadoresDoProjeto({ _count: { missions: 3671 } })

    expect(c).toHaveLength(1)
    expect(c[0]!.valor).toBe(3671)
    expect(c[0]!.rotulo.toLowerCase()).toContain('rodada')
  })

  test('nenhum contador de rodada usa palavra de entrega no rótulo', () => {
    for (const c of contadoresDoProjeto({ _count: { missions: 1327 } })) {
      if (c.fonte !== 'rodadas') continue
      expect(c.rotulo).not.toMatch(PALAVRAS_DE_ENTREGA)
    }
  })

  test('projeto sem contagem vira 0, não quebra', () => {
    expect(contadoresDoProjeto({}).at(0)?.valor).toBe(0)
  })
})
