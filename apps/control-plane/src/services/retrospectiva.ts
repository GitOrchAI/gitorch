// A retrospectiva do Scrum — a única parte do método que olha para TRÁS.
//
// O evento já estava escrito e nunca tinha sido ligado. O playbook
// `packages/cadence/playbooks/events/sprint-retro.md` existe completo, o tipo
// `CadenceEvent` já inclui 'sprint-retro', e o playbook nomeia exatamente as
// medidas certas — taxa de retrabalho, entregas que voltaram, tempo bloqueado,
// latência de delegação. Mas `loadEventPlaybook('sprint-retro')` só era chamado
// num teste, e a agenda padrão de um projeto só tinha ra, po, sm e qa.
//
// O efeito disso é que o ciclo só olhava para frente: uma entrega falhava, o QA
// reprovava, e nada daquilo mudava o ciclo seguinte — nem o pedido ao dev, nem
// o critério de aceitação, nem a cadência. Cada falha morria isolada, e os
// números foram piorando sem ninguém olhar: em 23/08/2026, 68% das sessões
// precisavam de empurrão, 36% das que fechavam eram abandonadas, e 93% das
// acordadas do julgamento não tinham nada para julgar.
//
// Este módulo é PURO de propósito: recebe as linhas já lidas e devolve o
// retrato. Sem banco, sem rede, sem relógio próprio — é o que permite testar o
// retrato com números difíceis sem precisar produzi-los de verdade.

/** Uma sessão de trabalho, com só o que a medida precisa. */
export interface SessaoMedida {
  /** `merged`, `abandoned`, `failed_final`... ou `null` se ainda está aberta. */
  closedReason: string | null
  /** Quantas vezes foi preciso empurrar para ela não travar esperando resposta. */
  nudges: number
  createdAt: Date
  closedAt: Date | null
}

/** Uma missão do relógio, com só o que a medida precisa. */
export interface MissaoMedida {
  /** `agent-run-qa`, `agent-run-sm`... */
  type: string
  /** Acordou e não havia nada para fazer. */
  noOp: boolean
}

export interface Retrato {
  /**
   * Não houve nem sessão nem missão no período.
   *
   * Existe para a retrospectiva DIZER que não tem medida, em vez de apresentar
   * zeros como se fossem medição. Um projeto novo na primeira semana cairia
   * exatamente aqui, e "0% de abandono" ali seria uma mentira otimista.
   */
  semDados: boolean
  entregasMescladas: number
  entregasAbandonadas: number
  /** Entre as que FECHARAM. `null` quando nenhuma fechou. */
  taxaDeAbandono: number | null
  sessoesQuePrecisaramDeEmpurrao: number
  taxaDeEmpurrao: number | null
  /** Mediana, não média: uma sessão esquecida por uma semana distorceria a média. */
  horasMedianasAteFechar: number | null
  /** Papel → quantas acordadas e quantas em falso. */
  acordadasEmFalsoPorPapel: Record<string, { total: number; emFalso: number }>
  fim: Date
}

export interface ArgumentosDaMedida {
  sessoes: SessaoMedida[]
  missoes: MissaoMedida[]
  fim: Date
}

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null
  const ordenados = [...valores].sort((a, b) => a - b)
  const meio = Math.floor(ordenados.length / 2)
  return ordenados.length % 2 === 0
    ? ((ordenados[meio - 1] ?? 0) + (ordenados[meio] ?? 0)) / 2
    : (ordenados[meio] ?? 0)
}

/** O retrato do período, só com o que foi de fato medido. */
export function medirRetrospectiva(args: ArgumentosDaMedida): Retrato {
  const fechadas = args.sessoes.filter((s) => s.closedAt !== null)
  const mescladas = fechadas.filter((s) => s.closedReason === 'merged').length
  // Só o que fechou SEM ter sido entregue conta como abandono. Sessão ainda
  // aberta é trabalho em andamento, e contá-la aqui seria condenar quem ainda
  // está trabalhando.
  //
  // Fechada COM `closedReason` nulo também conta como abandono, e isso é
  // deliberado: a versão anterior exigia motivo preenchido, então uma linha
  // fechada sem motivo entrava no denominador e em nenhum numerador —
  // diluindo a taxa e fazendo o retrato parecer melhor do que é. O que
  // importa para a medida é ter fechado sem entregar; o motivo é detalhe.
  const abandonadas = fechadas.filter((s) => s.closedReason !== 'merged').length

  const comEmpurrao = args.sessoes.filter((s) => s.nudges > 0).length

  const horas = fechadas
    .map((s) => (s.closedAt!.getTime() - s.createdAt.getTime()) / 3_600_000)
    // Duração negativa é relógio torto ou dado corrompido, não uma entrega
    // instantânea. Deixar entrar puxaria a mediana para baixo e faria a
    // esteira parecer mais rápida do que é — a medida mentiria a favor.
    .filter((h) => h >= 0)

  const porPapel: Record<string, { total: number; emFalso: number }> = {}
  for (const m of args.missoes) {
    const papel = m.type.replace(/^agent-run-/, '')
    const atual = porPapel[papel] ?? { total: 0, emFalso: 0 }
    atual.total += 1
    if (m.noOp) atual.emFalso += 1
    porPapel[papel] = atual
  }

  return {
    semDados: args.sessoes.length === 0 && args.missoes.length === 0,
    entregasMescladas: mescladas,
    entregasAbandonadas: abandonadas,
    taxaDeAbandono: fechadas.length > 0 ? abandonadas / fechadas.length : null,
    sessoesQuePrecisaramDeEmpurrao: comEmpurrao,
    taxaDeEmpurrao: args.sessoes.length > 0 ? comEmpurrao / args.sessoes.length : null,
    horasMedianasAteFechar: mediana(horas),
    acordadasEmFalsoPorPapel: porPapel,
    fim: args.fim,
  }
}

/** A melhoria escolhida: uma área, e o número que a justifica. */
export interface Melhoria {
  area: string
  porque: string
}

/**
 * Limiares acima dos quais uma medida vira problema digno de melhoria.
 *
 * São números redondos e conservadores de propósito. O objetivo não é
 * perseguir a perfeição — é que a retrospectiva só fale quando tem o que
 * dizer, porque uma cerimônia que reclama toda semana vira ruído que ninguém
 * lê, e aí ela deixa de servir para qualquer coisa.
 */
const DOI_ACIMA_DE = {
  abandono: 0.25,
  empurrao: 0.5,
  acordadaEmFalso: 0.5,
}

/**
 * Escolhe UMA melhoria — a que mais dói — ou `null` quando não há do que
 * reclamar.
 *
 * UMA é o que o playbook pede, e é deliberado: escolher três é escolher
 * nenhuma. Devolver `null` num período saudável também é deliberado —
 * inventar melhoria quando está tudo bem é o jeito mais rápido de a
 * retrospectiva virar ruído.
 *
 * A escolha carrega SEMPRE o número que a justifica. "O julgamento está
 * acordando à toa" não é acionável; "93% das acordadas do julgamento não
 * tinham nada para julgar" é.
 */
export function escolherAMelhoria(r: Retrato): Melhoria | null {
  if (r.semDados) return null

  const pct = (n: number) => `${Math.round(n * 100)}%`
  const candidatas: Array<{ dor: number; melhoria: Melhoria }> = []

  if (r.taxaDeAbandono !== null && r.taxaDeAbandono > DOI_ACIMA_DE.abandono) {
    candidatas.push({
      dor: r.taxaDeAbandono,
      melhoria: {
        area: 'entregas abandonadas',
        porque:
          `${pct(r.taxaDeAbandono)} das entregas que terminaram no período foram abandonadas ` +
          `(${r.entregasAbandonadas} de ${r.entregasAbandonadas + r.entregasMescladas}). ` +
          `Trabalho encomendado que nunca chegou.`,
      },
    })
  }

  if (r.taxaDeEmpurrao !== null && r.taxaDeEmpurrao > DOI_ACIMA_DE.empurrao) {
    candidatas.push({
      dor: r.taxaDeEmpurrao,
      melhoria: {
        area: 'entregas que travam sozinhas',
        porque:
          `${pct(r.taxaDeEmpurrao)} das entregas precisaram de pelo menos um empurrão para não ` +
          `travar esperando resposta. O pedido inicial não está bastando.`,
      },
    })
  }

  for (const [papel, contagem] of Object.entries(r.acordadasEmFalsoPorPapel)) {
    if (contagem.total === 0) continue
    const taxa = contagem.emFalso / contagem.total
    if (taxa <= DOI_ACIMA_DE.acordadaEmFalso) continue
    candidatas.push({
      dor: taxa,
      melhoria: {
        area: `acordadas em falso do ${papel}`,
        porque:
          `${pct(taxa)} das acordadas do ${papel} não tinham nada para fazer ` +
          `(${contagem.emFalso} de ${contagem.total}). Cota gasta sem trabalho produzido.`,
      },
    })
  }

  if (candidatas.length === 0) return null
  candidatas.sort((a, b) => b.dor - a.dor)
  return candidatas[0]!.melhoria
}
