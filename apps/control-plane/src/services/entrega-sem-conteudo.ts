// "Este pull request do dev assíncrono tem ALGUMA mudança, ou está vazio?"
//
// Medido: PR #468 (GitOrchAI/gitorch, issue #309), 03-05/09/2026. Duas
// reviews CHANGES_REQUESTED de gitorch-ai[bot], as duas no MESMO commit
// (84ab0094ee2404b2997fe765bdc00ec2ed916288) — o head atual — e o parecer do
// QA dizia, com todas as letras: "NÃO ATENDIDO (Diff vazio no PR #468) ... As
// modificações locais precisam ser comitadas e enviadas ao branch remoto". O
// dev trabalhou na máquina dele e nunca empurrou o commit. O CI estava 6 de
// 6 verde — verde de VAZIO, não de aprovado.
//
// O julgamento estava CERTO. O que faltava era o produto REAGIR: nenhuma
// regra reconhecia "diff vazio" como categoria própria, então a entrega
// ficava presa em julgamento — ocupando a vaga da conta e travando qualquer
// tarefa que dependesse dela.
//
// PURO NA DECISÃO — mesma disciplina de `pr-delegado.ts` e
// `entrega-travada-no-teto.ts`: ler "isto é entrega sem conteúdo?" não
// precisa de rede nem de banco, só dos campos que o GitHub já devolve no GET
// do pull request (o mesmo GET que `qa-rails-mission.ts` já faz — nenhuma
// chamada nova).

/** Os três campos do pull request que o GitHub já devolve no GET simples —
 *  sem nenhuma chamada extra. */
export interface EstatisticasDoPr {
  changed_files?: number
  additions?: number
  deletions?: number
}

/**
 * Este PR não tem NENHUMA mudança de código?
 *
 * `changed_files` é o sinal primário — o GitHub sempre o devolve no GET do
 * pull request, e ele conta arquivo mesmo quando falta o patch textual (ex.:
 * arquivo binário). Quando ele não vier (formato de resposta incompleto, ou
 * um dublê de teste que não o simula), o recuo é `additions`/`deletions`: as
 * duas exatamente zero é a mesma prova de que nada foi empurrado.
 *
 * Sem NENHUM dos três campos presente, a resposta é "não dá para dizer que
 * está vazio" (`false`) — na dúvida, o PR segue para o julgamento normal em
 * vez de ser tratado como vazio por engano.
 */
export function ehEntregaSemConteudo(pr: EstatisticasDoPr): boolean {
  if (typeof pr.changed_files === 'number') return pr.changed_files === 0
  if (typeof pr.additions === 'number' && typeof pr.deletions === 'number') {
    return pr.additions === 0 && pr.deletions === 0
  }
  return false
}

/**
 * A mensagem que o dev assíncrono recebe por `sendMessage` (via
 * `avisarSessao` — o MESMO caminho que qualquer reprovação normal já usa,
 * ver o aviso de rework em `qa-rails-mission.ts`).
 *
 * Deliberadamente NÃO vem do motor: "o diff está vazio" é um fato
 * estrutural, lido do próprio GitHub — pedir ao motor para "julgar" um PR
 * sem NENHUMA mudança seria opinião sobre nada, e correria o risco (prompt
 * malformado, alucinação) de aprovar o que não existe. Um texto fixo,
 * sempre igual para o mesmo fato, é mais confiável do que qualquer leitura
 * do motor sobre este caso específico — e é o que garante, por construção,
 * que este caminho nunca aprova (ver `ehEntregaSemConteudo` no call site:
 * o motor nem chega a ser chamado).
 */
export function textoDeEntregaSemConteudo(numeroDoPr: number): string {
  return [
    `GitOrch QA reviewed pull request #${numeroDoPr} and found NO CHANGES (empty diff).`,
    '',
    'The work never reached the repository: no commit was pushed to this pull ' +
      "request's branch. Local commits on your machine are not visible here — only " +
      'what is pushed to this branch counts.',
    '',
    `Push the missing commit(s) to the branch of pull request #${numeroDoPr}. Do not ` +
      'open a new pull request.',
  ].join('\n')
}
