/**
 * Verificador de "PR desta automação de segurança".
 *
 * Regra: elegibilidade exige EVIDÊNCIA POSITIVA de que o PR nasceu da automação. São três, e só
 * três: (1) o autor é o bot do Dependabot; (2) o próprio PR carrega label da automação; (3) o
 * corpo traz o rodapé que o dev assíncrono escreve ao abrir o PR.
 *
 * Por que não basta procurar a frase do rodapé em qualquer lugar do corpo (era o que se fazia):
 * PRs do dev saem com o AUTOR do dono e SEM label, então a frase virou o único sinal — e a
 * checagem era `body.includes(frase)`. Qualquer PR do dono que só FALASSE da automação (citando
 * a frase entre aspas, num bloco de código de documentação, ou ao responder review com `>`)
 * passava a ser tratado como PR da automação e podia receber comentário `@jules` automático.
 * Por isso o rodapé só conta quando aparece como rodapé de verdade — linha própria, no formato
 * que o dev emite — e o texto citado é descartado antes da comparação.
 *
 * Também caiu o caminho "o PR fecha uma issue com label jules/dependabot": isso é evidência
 * sobre a ISSUE, não sobre quem abriu o PR. O dono fechando na mão uma issue rotulada `jules`
 * era classificado como automação.
 */

import type { Octokit } from '@octokit/rest'

/** Contas de bot que são, por si só, prova de que o PR é da automação. */
const AUTORES_DA_AUTOMACAO = ['dependabot[bot]', 'dependabot-preview[bot]']

/** Labels que a automação põe no PRÓPRIO PR (não na issue). */
const LABELS_DA_AUTOMACAO = ['jules', 'dependabot']

/**
 * Rodapé emitido pelo dev assíncrono ao abrir o PR. Duas formas vistas em produção: com link da
 * tarefa (`for task [123](https://jules.google.com/task/123)`) e a antiga, só com o número.
 * Ancorado em início de linha — no máximo marcação de itálico/negrito antes — para que a mesma
 * frase escrita no meio de uma prosa não valha como rodapé.
 */
const RODAPE_DO_DEV =
  /^[ \t*_]*PR created automatically by Jules for task\s+(?:\[\d+\]\(https:\/\/jules\.google\.com\/task\/\d+\)|\d+)[^\n]*started by @[\w-]+/m

/**
 * Remove do corpo tudo que é TEXTO CITADO: blocos de código (``` e ~~~), código inline (`) e
 * linhas de citação (>). Citar o rodapé não é ser o rodapé — é justamente o que um PR do dono
 * sobre esta automação faz.
 */
function semTrechosCitados(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n')
    .filter((linha) => !/^\s{0,3}>/.test(linha))
    .join('\n')
}

function labelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
}

/** Retorna true se o corpo traz o rodapé que o dev assíncrono escreve (e não uma citação dele). */
export function temRodapeDoDev(body: string | null | undefined): boolean {
  return RODAPE_DO_DEV.test(semTrechosCitados(body ?? ''))
}

/** Dados do PR que bastam para decidir elegibilidade — sem precisar de rede. */
export interface SinaisDePR {
  user?: { login?: string } | null
  labels?: Array<string | { name?: string }> | null
  body?: string | null
}

/**
 * Decide pela evidência positiva. Separado da chamada de API para ser testado com o corpo exato
 * dos PRs reais, sem stub de rede — e é isso que os testes fazem: os corpos de `__fixtures__/
 * corpos-reais-de-pr.ts` foram capturados com `gh pr view <n> --json body` dos PRs #388 e #393
 * (dev assíncrono) e #347 e #361 (do dono), e colados byte a byte.
 */
export function ehPRDaAutomacao(pr: SinaisDePR): boolean {
  const autor = pr.user?.login ?? ''
  if (AUTORES_DA_AUTOMACAO.includes(autor)) return true

  const labels = labelNames(pr.labels ?? [])
  if (labels.some((l) => LABELS_DA_AUTOMACAO.includes(l))) return true

  return temRodapeDoDev(pr.body)
}

/** Retorna true se o PR pertence à automação de segurança (Dependabot/dev assíncrono). */
export async function isSecurityAutomationPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<boolean> {
  const pr = (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data
  return ehPRDaAutomacao(pr)
}

/**
 * Retorna true se o PR foi criado pelo dev assíncrono (tem uma sessão real escutando comentários).
 *
 * Diferença crítica de `isSecurityAutomationPR`: um PR do Dependabot PURO (rotina, sem passar
 * pelo dev — ex.: bump de versão de devDependency) É elegível pra automação de segurança
 * (auto-merge etc.), mas NÃO tem sessão do dev ativa. Comentar `@jules` nesse PR não faz
 * nada — ninguém está escutando. Só um PR que o próprio dev abriu tem sessão pra reagir a
 * menções. Visto ao vivo: PR #213 (bump de @types/node) travado com CI vermelho, `@jules` seria
 * um comentário no vazio.
 */
export function hasActiveJulesSession(pr: { body?: string | null }): boolean {
  return temRodapeDoDev(pr.body)
}

/** O que esta automação está autorizada a fazer num PR. */
export interface AcaoNoPR {
  /**
   * O PR é da automação. Autoriza apenas trabalho de LEITURA: detectar conflito e tirar a label
   * `jules-conflict-notified` de quem voltou a ser mesclável.
   */
  noEscopo: boolean
  /**
   * Existe uma sessão do dev assíncrono escutando neste PR. É o ÚNICO caminho que autoriza
   * ESCREVER nele.
   */
  podeComentar: boolean
}

/**
 * Decide, a partir de UM retrato do PR, as duas coisas que a automação precisa saber.
 *
 * Existe porque estar NO ESCOPO e poder ESCREVER são decisões diferentes, e tratá-las como uma
 * só foi um furo real: `analyze-conflicts.ts` gateava com `isSecurityAutomationPR` e ia direto
 * postar, sem nunca consultar `hasActiveJulesSession` (zero ocorrências no arquivo). O texto
 * postado começa com `@jules` — num PR do Dependabot puro isso é falar sozinho, e num PR humano
 * seria a automação empurrando trabalho para dentro do PR de outra pessoa.
 *
 * `podeComentar` é ESTRITAMENTE mais forte que `noEscopo`: o rodapé do dev é um dos três sinais
 * que compõem `noEscopo`, então quem passa no primeiro já passou no segundo. Por isso os dois
 * não são combinados com `&&` — seria uma redundância fingindo que são independentes. O teste
 * `podeComentar implica noEscopo` tranca essa relação para quem mexer nas regras depois.
 *
 * Fica aqui, e não no script, por um motivo prático: os scripts de topo chamam `main()` no
 * carregamento do módulo, então importá-los de um teste executaria a automação. Ponto de decisão
 * que não pode ser importado não pode ser testado — e foi assim que o furo passou.
 */
export function decidirAcaoNoPR(pr: SinaisDePR): AcaoNoPR {
  return { noEscopo: ehPRDaAutomacao(pr), podeComentar: hasActiveJulesSession(pr) }
}
