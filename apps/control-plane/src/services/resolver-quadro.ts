// Qual quadro do Projects V2 é o do cliente — e o que fazer quando não há um.
//
// A sprint do GitOrch vive no campo de ITERAÇÃO do quadro (a visão Roadmap do
// GitHub é só esse campo desenhado no eixo do tempo). Antes de mexer em sprint,
// é preciso saber EM QUAL quadro. E a realidade tem mais casos do que parece:
// os oito abaixo foram levantados na conta do próprio dono, em 29/08 — nenhum
// é hipótese.
//
// Esta camada só DECIDE. Criar quadro, ligar ao repositório e configurar sprint
// é execução, e vem depois — separado de propósito, porque escrever no
// repositório do cliente é a parte que não se faz por engano.

/** Um quadro candidato, do jeito que a decisão precisa enxergar. */
export interface QuadroCandidato {
  id: string
  number: number
  title: string
  /** Arquivado. Nunca deve ser adotado. */
  closed: boolean
  /** Está anunciado no repositório? */
  linkado: boolean
  /** Quantas issues deste repositório já estão dentro dele (evidência de uso). */
  issuesDesteRepo?: number
  /**
   * Quantos itens o quadro tem no total — o sinal mais forte de uso real.
   *
   * Medido no repositório do dono em 31/08: o quadro que ele cuida à mão tinha
   * 146 itens e os dois que o produto criou tinham ZERO. Chamar isso de empate
   * é o que fazia o produto pedir uma escolha que nunca precisou ser feita.
   */
  itensCount?: number
  /** Quantos campos o quadro tem: quanto alguém já investiu nele. */
  camposCount?: number
}

export type DecisaoDeQuadro =
  | {
      acao: 'usar'
      quadro: QuadroCandidato
      /** Precisa anunciar o quadro no repositório antes de usar. */
      precisaLigar: boolean
      motivo: string
    }
  | { acao: 'criar'; motivo: string }
  | {
      acao: 'escolher'
      /** Mais de um candidato igualmente plausível: quem decide é o dono. */
      candidatos: QuadroCandidato[]
      motivo: string
    }
  | {
      acao: 'sem_acesso'
      /**
       * A conta tem quadros, mas a credencial em uso não os enxerga. Acontece
       * com repositório em CONTA PESSOAL: sem a autorização de quadros, a API
       * responde sucesso com lista vazia — "não vejo" é indistinguível de "não
       * existe" se ninguém separar os dois.
       */
      motivo: string
    }

/**
 * Os critérios de desempate, do sinal mais FORTE para o mais fraco.
 *
 * Itens antes de campos de propósito: campo é o que alguém configurou uma vez,
 * item é o que alguém usa todo dia. Um quadro recém-criado já nasce com os 13
 * campos padrão do GitHub — se campos viessem primeiro, dois quadros vazios
 * empatariam com o quadro de verdade em vez de perder para ele.
 */
const CRITERIOS_DE_DESEMPATE: ReadonlyArray<{
  valor: (q: QuadroCandidato) => number
  frase: (n: number) => string
}> = [
  { valor: (q) => q.itensCount ?? 0, frase: (n) => `é o único com ${n} item(ns) dentro` },
  { valor: (q) => q.camposCount ?? 0, frase: (n) => `é o que tem mais campos (${n})` },
]

/**
 * Desempata entre candidatos igualmente plausíveis — e só quando o desempate é
 * ÓBVIO.
 *
 * Devolve vencedor apenas se algum critério o separa SOZINHO do segundo
 * colocado. Empate de verdade continua sendo pergunta ao dono: a correção aqui
 * é parar de chamar 146-contra-zero de empate, não passar a adivinhar.
 */
function desempatar(
  candidatos: readonly QuadroCandidato[]
): { vencedor: QuadroCandidato; motivo: string } | null {
  if (candidatos.length === 1) return { vencedor: candidatos[0]!, motivo: 'é o único vivo' }

  for (const criterio of CRITERIOS_DE_DESEMPATE) {
    const ordenados = [...candidatos].sort((a, b) => criterio.valor(b) - criterio.valor(a))
    const topo = criterio.valor(ordenados[0]!)
    // Zero no topo = ninguém tem este sinal; não separa nada, e "todo mundo com
    // nada" não pode eleger o primeiro da lista por acaso.
    if (topo === 0) continue
    // Empatados no topo: este critério não decide, o próximo pode decidir.
    if (criterio.valor(ordenados[1]!) === topo) continue
    return { vencedor: ordenados[0]!, motivo: criterio.frase(topo) }
  }
  return null
}

/**
 * Decide qual quadro usar.
 *
 * A ordem das regras é a ordem do risco: primeiro descartar o que nunca serve
 * (arquivado), depois preferir a evidência mais forte (linkado), depois a
 * evidência de uso (issues dentro dele), e só então admitir que não dá para
 * decidir sozinho.
 */
export function decidirQuadro(args: {
  candidatos: readonly QuadroCandidato[]
  /**
   * A conta é pessoal e a credencial não tem a autorização de quadros. Quando
   * verdadeiro, lista vazia significa "não enxergo", não "não existe" — e
   * criar um quadro por cima duplicaria o que o cliente já tem.
   */
  podeEstarCego?: boolean
}): DecisaoDeQuadro {
  // Cenário 5: arquivado sai da disputa antes de qualquer outra regra. Adotar
  // um quadro fechado faz o produto escrever sprint num lugar que ninguém abre.
  const vivos = args.candidatos.filter((q) => !q.closed)

  if (vivos.length === 0) {
    if (args.podeEstarCego) {
      return {
        acao: 'sem_acesso',
        motivo:
          'Não enxergo quadro nenhum nesta conta. Repositório em conta pessoal precisa da autorização de quadros — sem ela, criar um novo duplicaria o que já existe.',
      }
    }
    // Cenário 3: não há quadro mesmo. Criar é seguro.
    return {
      acao: 'criar',
      motivo:
        args.candidatos.length > 0
          ? 'Os quadros existentes estão arquivados; nenhum serve.'
          : 'O repositório não tem quadro.',
    }
  }

  // Cenários 1 e 4: o linkado ganha. Estar anunciado no repositório é a
  // declaração mais forte de "este é o quadro deste projeto".
  const linkados = vivos.filter((q) => q.linkado)
  if (linkados.length === 1) {
    return {
      acao: 'usar',
      quadro: linkados[0]!,
      precisaLigar: false,
      motivo: 'É o quadro ligado ao repositório.',
    }
  }
  if (linkados.length > 1) {
    // O LAÇO: aqui a resposta era sempre `escolher`, e o caminho que criava
    // quadro tratava a falta de resposta como falta de quadro — criava mais um,
    // que ficava ligado, e a volta seguinte tinha mais um empate. Cada tentativa
    // de sair do problema piorava o problema. Desempatar quando é óbvio é o que
    // fecha o laço; pedir só quando é empate de verdade é o que o dono merece.
    const desempate = desempatar(linkados)
    if (desempate) {
      return {
        acao: 'usar',
        quadro: desempate.vencedor,
        precisaLigar: false,
        motivo: `Há ${linkados.length} quadros ligados ao repositório, e este ${desempate.motivo}.`,
      }
    }
    return {
      acao: 'escolher',
      candidatos: linkados,
      motivo:
        'Há mais de um quadro ligado ao repositório e nenhum se destaca em uso; só o dono sabe qual vale.',
    }
  }

  // Cenário 2: existe quadro, nenhum linkado. Desempata por USO — issues deste
  // repositório dentro dele são fato, não parecença. (Casar por título já
  // adotou o quadro de um repositório para outro sem relação nenhuma.)
  const comUso = vivos
    .filter((q) => (q.issuesDesteRepo ?? 0) > 0)
    .sort((a, b) => (b.issuesDesteRepo ?? 0) - (a.issuesDesteRepo ?? 0))

  if (
    comUso.length === 1 ||
    (comUso.length > 1 && comUso[0]!.issuesDesteRepo !== comUso[1]!.issuesDesteRepo)
  ) {
    return {
      acao: 'usar',
      quadro: comUso[0]!,
      precisaLigar: true,
      motivo: `Não está ligado ao repositório, mas já tem ${comUso[0]!.issuesDesteRepo} issue(s) dele dentro.`,
    }
  }
  if (comUso.length > 1) {
    const desempate = desempatar(comUso)
    if (desempate) {
      return {
        acao: 'usar',
        quadro: desempate.vencedor,
        precisaLigar: true,
        motivo: `Empate no número de issues deste repositório, mas este ${desempate.motivo}.`,
      }
    }
    return {
      acao: 'escolher',
      candidatos: comUso,
      motivo: 'Mais de um quadro tem o mesmo tanto de issues deste repositório.',
    }
  }

  // Existe quadro vivo, mas nenhum ligado e nenhum com issue deste repositório.
  // Pode ser de outro projeto da mesma conta — adotar seria invadir. Um só
  // ainda merece a pergunta; vários, mais ainda.
  return {
    acao: 'escolher',
    candidatos: vivos,
    motivo:
      'Há quadro na conta, mas nenhum ligado a este repositório nem com issue dele dentro — pode ser de outro projeto.',
  }
}
