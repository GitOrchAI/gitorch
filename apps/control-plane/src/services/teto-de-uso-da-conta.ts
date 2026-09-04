/**
 * "Acabou a cota" e "o login venceu" são coisas diferentes, e o dono pagou
 * caro pela confusão.
 *
 * EM 27/08 ele religou o Codex DUAS VEZES no mesmo dia. Nas duas, o motor
 * voltou a funcionar por algumas horas e caiu de novo, e o produto pediu
 * religar outra vez. Palavra dele: "sobre codex, pq religar de novo? precisa
 * urgentemente resolver esse problema de perder conexão".
 *
 * Rodando o CLI na mão, com o rastreio ligado, o provedor respondeu isto,
 * literalmente:
 *
 *     You've hit your usage limit. Upgrade to Plus to continue using Codex
 *
 * Não é credencial vencida. É a CONTA no teto de uso. Religar não resolve —
 * só o tempo (ou um plano maior) resolve. O dono refez o login duas vezes por
 * um diagnóstico errado do produto.
 *
 * E havia um segundo defeito, medido: o texto do Codex nem sequer era
 * reconhecido como problema de cota. O padrão de troca de motor procura
 * "quota", "rate limit", "429" — e "usage limit" não casa com nenhum. O
 * Antigravity, que diz "Individual quota reached", casava; o Codex, não. A
 * mesma situação, tratada de dois jeitos, por acaso de vocabulário.
 *
 * Este arquivo existe para que a distinção seja feita UMA vez, por tipo, e
 * não por regex espalhado — a mesma disciplina de `credencial-do-motor.ts`.
 */

/**
 * As frases que os provedores usam para dizer "sua conta bateu no teto".
 *
 * Todas verificadas em saída real, não imaginadas:
 * - "You've hit your usage limit" — Codex/OpenAI, capturado em 27/08.
 * - "Individual quota reached" — Antigravity, nas falhas de 26 e 27/08.
 * - "usage limit reached" / "quota exceeded" — variantes comuns dos mesmos
 *   provedores; entram porque o custo de reconhecer uma frase a mais é zero e
 *   o de não reconhecer é mandar o dono refazer login à toa.
 */
const FRASES_DE_TETO = [
  /hit your usage limit/i,
  /usage limit reached/i,
  /individual quota reached/i,
  /quota (?:reached|exceeded)/i,
  /you (?:have )?exceeded your (?:current )?quota/i,
  /upgrade to (?:plus|pro) to continue/i,
]

/**
 * Esta saída diz que a CONTA acabou (e não que o login venceu)?
 *
 * Deliberadamente independente de `ehCredencialExpirada`: as duas perguntas
 * são diferentes e a resposta muda o que o dono precisa fazer. Uma pede
 * espera; a outra pede login.
 */
export function ehTetoDeUsoDaConta(saida: string): boolean {
  return FRASES_DE_TETO.some((frase) => frase.test(saida))
}

/**
 * Quando a cota volta, se o provedor disse.
 *
 * O Antigravity informa um CONTADOR relativo ("Resets in 15h41m4s"). O Codex,
 * medido ao vivo (L4-T22), informa uma DATA E HORA absolutas — "... or try
 * again at Sep 21st, 2026 6:00 AM" — outro vocabulário para a mesma
 * informação, exatamente a mesma lacuna que "usage limit" já tinha sido para
 * `isFailoverError` (ver o comentário no topo deste arquivo): um formato novo
 * não bate em nenhum padrão antigo e o produto trata como se ninguém tivesse
 * dito nada. Quando NENHUM dos dois formatos aparece, devolve `null` em vez
 * de inventar um horário — um prazo errado é pior que nenhum, porque o dono
 * organiza o dia em cima dele.
 */
export function quandoACotaVolta(saida: string): string | null {
  const relativo = /resets? in ([0-9]+h)?\s?([0-9]+m)?/i.exec(saida)
  if (relativo && (relativo[1] || relativo[2])) {
    return [relativo[1], relativo[2]].filter(Boolean).join('')
  }
  // Corta em ponto final, parêntese ou fim da frase — nunca engole o resto
  // da mensagem (ex.: "... (https://chatgpt.com/explore/plus)") junto da data.
  const absoluto = /try again at ([^.()\n]+)/i.exec(saida)
  if (absoluto?.[1]) {
    const data = absoluto[1].trim()
    if (data.length > 0) return data
  }
  return null
}

/**
 * O recado certo para o teto de uso.
 *
 * NÃO pede religar, de propósito — foi exatamente esse pedido que fez o dono
 * refazer o login duas vezes sem resolver nada. Diz o que é, o que resolve, e
 * quando volta, se souber.
 */
export function recadoDeTetoDeUso(args: { runtime: string; volta: string | null }): string {
  return [
    `GitOrch: a conta do motor ${args.runtime} bateu no teto de uso.`,
    '',
    args.volta
      ? `A cota volta em ${args.volta}. Até lá o trabalho segue pelos outros motores.`
      : 'O provedor não disse quando volta. Até lá o trabalho segue pelos outros motores.',
    '',
    'Isto NÃO é login vencido: religar o motor não resolve e não é preciso',
    'fazer nada. Se acontecer todo dia, o caminho é um plano maior nesse',
    'provedor, não uma reconexão.',
  ].join('\n')
}

/**
 * O aviso EXECUTIVO de quando a CADEIA INTEIRA de motores ficou sem cota
 * (L4-T22) — diferente de `recadoDeTetoDeUso` acima, que avisa POR MOTOR a
 * cada degrau que bate no teto (útil para o dono saber qual conta upar).
 * Este dispara só quando não sobrou NENHUM motor para tentar: é o resumo que
 * importa para quem não é técnico — o time ficou sem capacidade, até quando
 * (se algum motor souber dizer) e quantas dúvidas do dev assíncrono estão
 * paradas esperando por causa disso.
 *
 * D71/D72: isto NUNCA é uma pergunta — é um informe, ponto final. Se um dia
 * isto precisar virar decisão (ex.: pausar alguma automação até a cota
 * voltar), a decisão sobe pelo caminho formal de `agent-question.ts` (pergunta
 * executiva + EXATAMENTE 3 opções + "Vou escrever"), nunca texto solto
 * perguntando algo técnico aqui.
 */
export function recadoDeMotoresEsgotados(args: {
  /** `quandoACotaVolta` do último motor tentado, ou `null` se ninguém disse. */
  ateQuando: string | null
  /** Quantas dúvidas do dev assíncrono estão esperando resposta agora. */
  duvidasEsperando: number
}): string {
  const prazo = args.ateQuando ? `até ${args.ateQuando}` : '— nenhum provedor disse até quando'
  const linhaDeDuvidas =
    args.duvidasEsperando > 0
      ? `Nesse meio tempo, ${args.duvidasEsperando} ${
          args.duvidasEsperando === 1 ? 'dúvida do dev está' : 'dúvidas do dev estão'
        } esperando resposta.`
      : 'Nesse meio tempo, não há nenhuma dúvida do dev esperando resposta.'
  return [
    `GitOrch: o time ficou sem capacidade de motor ${prazo}.`,
    '',
    linhaDeDuvidas,
    '',
    'Não é preciso fazer nada agora — quando a cota de algum motor voltar, o',
    'trabalho retoma sozinho.',
  ].join('\n')
}
