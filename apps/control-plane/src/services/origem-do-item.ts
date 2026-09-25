// A origem de um item (pull request ou commit): quem produziu o trabalho,
// pelas marcas que cada origem deixa no que a API do GitHub já devolve —
// nunca por adivinhação. Consumida pela Fase 2 (vínculo com a tarefa) e pela
// Fase 3 (cuidaPorOrigem, Tarefa 0.2, decide se o GitOrch julga sozinho).

import { ehPRDaAutomacao, temRodapeDoDev, type SinaisDePR } from './vigia-do-pr.js'

export type OrigemDoItem =
  'jules_gitorch' | 'jules_fora' | 'assistente' | 'pessoa' | 'dependabot' | 'outro_bot'

/** Contas de bot conhecidas que NÃO são o dev assíncrono nem o produto — ex.:
 *  Renovate, um bot de CI de terceiro. Ausência na lista não vira "é gente":
 *  o sufixo `[bot]` no login já é o sinal (ver `pareceContaDeBot`). */
const SUFIXO_DE_CONTA_DE_BOT = /\[bot\]$/

function pareceContaDeBot(login: string | null | undefined): boolean {
  return SUFIXO_DE_CONTA_DE_BOT.test(login ?? '')
}

/**
 * Assinaturas REAIS que cada assistente de código deixa no rodapé do commit —
 * o trailer `Co-Authored-By`, padrão git. Cada ferramenta escreve o PRÓPRIO
 * nome; casar por substring (não por igualdade exata) tolera a versão do
 * modelo mudar (`Claude Sonnet 5`, `Claude Opus 4` — todos começam com
 * "Claude").
 */
const ASSINATURAS_DE_ASSISTENTE = [
  /Co-Authored-By:\s*Claude/i,
  /Co-Authored-By:\s*Codex/i,
  /Co-Authored-By:\s*Antigravity/i,
]

function commitAssinadoPorAssistente(commits: SinaisDeOrigem['commits']): boolean {
  return commits.some((c) => ASSINATURAS_DE_ASSISTENTE.some((re) => re.test(c.mensagem)))
}

export interface SinaisDeOrigem extends SinaisDePR {
  /** Mensagens de commit do pull request, na ordem em que a API devolve. */
  commits: Array<{ mensagem: string; autorLogin: string | null }>
  /** Há sessão do dev assíncrono NESTE produto apontando para este pull
   *  request (`casarPrComSessao`, Fase 2.1)? Separa `jules_gitorch` de
   *  `jules_fora` — a MESMA evidência de rodapé existe nos dois casos; o que
   *  muda é se o GitOrch foi quem disparou a sessão. */
  temSessaoGitOrch: boolean
}

/**
 * Classifica pelo sinal mais forte primeiro — mesma disciplina de
 * `casarProjeto` em `github-webhook.ts`: do critério mais confiável ao mais
 * fraco, nunca um `OU` cego entre eles.
 */
export function classificarOrigem(sinais: SinaisDeOrigem): OrigemDoItem {
  // 1) Dependabot: autor de bot conhecido, sinal mais forte que existe.
  if (['dependabot[bot]', 'dependabot-preview[bot]'].includes(sinais.autor ?? ''))
    return 'dependabot'

  // 2) O dev assíncrono (Jules): rodapé próprio, verificável sem rede
  // OU via fallback pelo branch vinculado à sessão ativa do GitOrch.
  if (temRodapeDoDev(sinais.corpo) || sinais.temSessaoGitOrch) {
    return sinais.temSessaoGitOrch ? 'jules_gitorch' : 'jules_fora'
  }

  // 3) Assistente de código (Claude/Codex/Antigravity): trailer de commit.
  if (commitAssinadoPorAssistente(sinais.commits)) return 'assistente'

  // 4) Qualquer outro bot: login termina em [bot] mas não bateu em nenhuma
  // das assinaturas conhecidas acima.
  if (pareceContaDeBot(sinais.autor)) return 'outro_bot'

  // 5) Sem nenhum sinal de automação: é gente. `ehPRDaAutomacao` cobre o
  // resto do que os passos acima já não cobriram (labels da automação) —
  // reaproveitado aqui só como reforço, nunca como decisão isolada.
  if (ehPRDaAutomacao(sinais) && !pareceContaDeBot(sinais.autor)) return 'outro_bot'

  return 'pessoa'
}
