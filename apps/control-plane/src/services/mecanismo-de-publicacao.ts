// Descobre COMO um repositório publica — nunca supõe.
//
// Provado ao vivo que não há um sinal único: um projeto publica pelo
// mecanismo de deployment do GitHub (`GET /repos/{r}/environments` devolve
// `github-pages`, com estados waiting → queued → in_progress → success e
// `environment_url` de graça). Outro projeto real não usa `environment:` no
// seu workflow de publicação — não cria deployment nenhum — e o único sinal
// é a execução do workflow, cujos nomes de passo contam a história. Por
// isso o produto pergunta ao repositório em vez de assumir um dos dois.
//
// Preferência, nessa ordem: deployment (é o sinal do próprio sistema de
// publicação do GitHub) → workflow de publicação (nome/arquivo reconhecível)
// → nenhum mecanismo — resposta legítima, não erro.

/** Um ambiente como devolvido por `GET /repos/{o}/{r}/environments` (`environments[].name`). */
export type NomeDoAmbiente = string

/**
 * Uma entrada de `GET /repos/{o}/{r}/actions/workflows` (`workflows[]`),
 * reduzida ao que esta descoberta precisa. `ativo` vem de `state === 'active'`
 * na API real — quem injeta a leitura faz esse mapeamento.
 */
export interface WorkflowDoRepositorio {
  nome: string
  /** Caminho completo, ex.: `.github/workflows/cd.yml`. */
  arquivo: string
  ativo: boolean
}

export type Mecanismo =
  | { tipo: 'deployment'; ambientes: string[] }
  | { tipo: 'workflow'; arquivo: string; nome: string }
  | { tipo: 'nenhum' }

/**
 * Ambiente efêmero de entrega — um por PR aberto (ex.: preview de branch).
 * Existir não significa que o REPOSITÓRIO tem mecanismo de publicação
 * declarado; é descartável e nasce/morre com a entrega. Reconhecido pelo
 * padrão `PR #<número>` no nome, do jeito que o GitHub nomeia esses
 * ambientes automaticamente.
 */
const PADRAO_AMBIENTE_EFEMERO = /PR #\d+/

/**
 * Um workflow conta como publicação quando o nome OU o arquivo contêm uma
 * destas palavras inteiras — nunca por `ci`/`test`/`lint`/`check`, que
 * verificam código mas não o colocam no ar.
 */
const PADRAO_WORKFLOW_DE_PUBLICACAO = /\b(cd|deploy|release|publish)\b/i

function nomeDoArquivo(caminho: string): string {
  return caminho.split('/').pop() ?? caminho
}

export async function descobrirMecanismo(args: {
  /** Lê `GET /repos/{o}/{r}/environments`, devolvendo os nomes. */
  listarAmbientes: () => Promise<NomeDoAmbiente[]>
  /** Lê `GET /repos/{o}/{r}/actions/workflows`. */
  listarWorkflows: () => Promise<WorkflowDoRepositorio[]>
}): Promise<Mecanismo> {
  const ambientes = await args.listarAmbientes()
  const ambientesDeclarados = ambientes.filter((a) => !PADRAO_AMBIENTE_EFEMERO.test(a))
  if (ambientesDeclarados.length > 0) {
    return { tipo: 'deployment', ambientes: ambientesDeclarados }
  }

  const workflows = await args.listarWorkflows()
  const workflowDePublicacao = workflows.find(
    (w) =>
      w.ativo &&
      (PADRAO_WORKFLOW_DE_PUBLICACAO.test(w.nome) || PADRAO_WORKFLOW_DE_PUBLICACAO.test(w.arquivo))
  )
  if (workflowDePublicacao) {
    return {
      tipo: 'workflow',
      arquivo: nomeDoArquivo(workflowDePublicacao.arquivo),
      nome: workflowDePublicacao.nome,
    }
  }

  return { tipo: 'nenhum' }
}
