// O que o GitOrch INSTALA no repositório do cliente — os robôs da automação
// (rotear alerta do Dependabot, monitorar PR do Jules...). Quando UM DELES
// falha, é bug NOSSO, não do cliente: o Jules não tem contexto para
// consertar a nossa automação, e o dono do repositório não deveria receber
// uma issue sobre isso.
//
// Duas formas de reconhecer:
//  1. o marcador `# gitorch:managed` no conteúdo do workflow (o jeito certo,
//     para todo workflow que o produto instalar daqui pra frente);
//  2. a lista fixa abaixo — os que já existem nos dois repos de teste e nasceram
//     antes do marcador.
//
// A lista ENCOLHEU em 02/09/2026 (D62, PRs #456 e #3920): os 17 nomes abaixo
// — code-scanning-to-jules, dependabot-to-jules, jules-apology-handler,
// jules-auto-recovery, jules-pr-ci-failure, jules-pr-conflict, auto-merge,
// dependabot-alert-to-issue, ci-failure-handler, cd-failure-handler,
// auto-merge-monitor, jules-pr-monitor, jules-api-retry, jules-auto-merge,
// jules-ci-failure-fix, jules-merge-conflict-fix, jules-conflict-resolver —
// SAÍRAM da lista fixa. A PREMISSA: esses nomes só existiram nos DOIS
// repositórios de teste (GitOrchAI/gitorch e loureng/patinhas-3d-crafts),
// escritos à mão antes do marcador existir, e foram removidos de lá na
// consolidação da esteira única. Qualquer workflow que o produto instalar
// daqui pra frente carrega `gitorch:managed`; os `jules-*` continuam
// cobertos pela regex de convenção, marcador ou não.
//
// CONSEQUÊNCIA (é isso que se quer, não um efeito colateral a corrigir): se
// um desses 17 nomes aparecer em ALGUM repositório sem o marcador, esta
// função devolve `false` — deixa de ser reconhecido como scaffolding-do-
// gitorch. O produto não deve assumir autoria de um workflow que não
// instalou só porque o nome coincide com um que um dia existiu num repo de
// teste. Isso NÃO faz esses nomes virarem `ci-do-cliente`: os 17 casam a
// convenção de automação (jules-*, dependabot-*, auto-merge*, *-failure-
// handler...), então `classificarFalhaDeInfra` os classifica como
// `automacao` (proposta ao dono, nunca incidente P0 — ver
// `ehAutomacaoDoCliente` em classificar-falha-de-infra.ts, L4-T2/D63). Um
// nome legado que NÃO casasse aquela convenção é que viraria ci-do-cliente.

/** O marcador que todo workflow instalado pelo GitOrch carrega (ou deveria). */
export const MARCADOR_SCAFFOLDING = 'gitorch:managed'

/**
 * Basenames de workflow que o GitOrch instala e mantém. Lista de transição —
 * o alvo é todo workflow gerado carregar `MARCADOR_SCAFFOLDING` e esta lista
 * encolher. Cobre os dois repos de teste (gitorch + patinhas).
 *
 * Não adicione de volta os 17 nomes legados removidos em 02/09/2026 (D62,
 * PRs #456 e #3920) — ver o bloco de comentários no topo do arquivo. Eles só
 * existiram nos dois repos de teste, escritos à mão antes do marcador, e
 * saíram porque não existem mais lá. Se um workflow com um desses nomes
 * aparecer de novo em algum repositório SEM o marcador `gitorch:managed`, o
 * comportamento correto NÃO é voltar a inseri-lo aqui — é deixar
 * `classificarFalhaDeInfra` classificá-lo como `automacao` (proposta ao
 * dono, L4-T2/D63), já que o nome casa a convenção de automação do cliente.
 */
const BASENAMES_SCAFFOLDING = new Set([
  // GitOrchAI/gitorch
  'sla-tracker.yml',
  // loureng/patinhas-3d-crafts
  'dependabot-automation.yml',
  'cleanup-artifacts.yml',
  // jules-pr-labeler.yml (patinhas) já é coberto pela regex `jules-*.yml` abaixo.
])

/** Este workflow é da automação do GitOrch (não do CI do cliente)? */
export function ehScaffoldingDoGitorch(path: string, conteudo?: string): boolean {
  if (conteudo && conteudo.includes(MARCADOR_SCAFFOLDING)) return true
  const base = path.split('/').pop() ?? path
  if (BASENAMES_SCAFFOLDING.has(base)) return true
  // Qualquer `jules-*.yml` é scaffolding por convenção — nenhum CI de cliente
  // legítimo se chama assim.
  return /^jules-.*\.ya?ml$/.test(base)
}
