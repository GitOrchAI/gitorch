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
// A lista ENCOLHEU em 02/09 (D62): os workflows legados de automação
// concorrente (auto-merge, *-to-jules, *-failure-handler, auto-merge-monitor,
// dependabot-alert-to-issue...) foram removidos dos repos de teste na
// consolidação da esteira única — não existem mais, então saíram da lista.
// O que sobrou é só o que continua instalado de verdade hoje.

/** O marcador que todo workflow instalado pelo GitOrch carrega (ou deveria). */
export const MARCADOR_SCAFFOLDING = 'gitorch:managed'

/**
 * Basenames de workflow que o GitOrch instala e mantém. Lista de transição —
 * o alvo é todo workflow gerado carregar `MARCADOR_SCAFFOLDING` e esta lista
 * encolher. Cobre os dois repos de teste (gitorch + patinhas).
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
