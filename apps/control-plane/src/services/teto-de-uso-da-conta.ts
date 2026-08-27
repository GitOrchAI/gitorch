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
 * O Antigravity informa ("Resets in 15h41m4s"); o Codex, não. Devolver `null`
 * em vez de inventar um horário é o ponto: um prazo errado é pior que nenhum,
 * porque o dono organiza o dia em cima dele.
 */
export function quandoACotaVolta(saida: string): string | null {
  const m = /resets? in ([0-9]+h)?\s?([0-9]+m)?/i.exec(saida)
  if (!m || (!m[1] && !m[2])) return null
  return [m[1], m[2]].filter(Boolean).join('')
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
