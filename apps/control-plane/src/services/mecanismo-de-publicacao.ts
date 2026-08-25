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
 * `deploy`, `deployment`, `release` e `publish` são inequívocos: nenhuma
 * palavra de verificação de código se escreve assim. `deployment` entra como
 * alternativa PRÓPRIA (não só um sufixo de `deploy`) porque `\bdeploy\b`
 * exige fronteira de palavra nos dois lados — e depois de "deploy" vem "ment"
 * (letra-letra, sem fronteira), então `continuous-deployment` não casava:
 * lacuna real, achada na revisão final da branch, que fazia o produto
 * declarar "não publica" para um repositório que publica por esse nome. Já
 * `cd` é ambíguo por construção — é ao mesmo tempo a abreviação de
 * "continuous deployment" E um token de duas letras que aparece dentro de
 * nomes como `cd-lint-check` sem ligação nenhuma com publicação. Por isso ele
 * é tratado à parte, abaixo.
 */
const PADRAO_PUBLICACAO_INEQUIVOCA = /\b(deploy|deployment|release|publish)\b/i

/** O token ambíguo — só ele precisa do desempate por vocabulário de verificação. */
const PADRAO_TOKEN_CD = /\bcd\b/i

/**
 * Vocabulário que, ao lado do token ambíguo `cd`, denuncia um workflow de
 * VERIFICAÇÃO (testes, lint, CI) — não de publicação. Lista nomeada e
 * exportada de propósito: quem precisar reconhecer mais um termo de
 * verificação (ex.: `smoke`, `typecheck`) mexe só aqui.
 */
export const VOCABULARIO_DE_VERIFICACAO = [
  'test',
  'tests',
  'lint',
  'check',
  'checks',
  'ci',
  'build',
] as const

const PADRAO_VOCABULARIO_DE_VERIFICACAO = new RegExp(
  `\\b(${VOCABULARIO_DE_VERIFICACAO.join('|')})\\b`,
  'i'
)

/**
 * Decide se um texto (nome OU arquivo de um workflow) indica publicação.
 *
 * `deploy`/`release`/`publish` bastam sozinhos — palavra inteira, sem
 * ambiguidade possível. Já o token `cd` só conta se o MESMO texto não
 * carregar também vocabulário de verificação: `cd.yml` ou `CD` sozinho
 * continuam reconhecidos (é o nome real mais comum), mas `cd-lint-check` ou
 * `cd-tests` não — ali o `cd` é coincidência de nome, não o mecanismo de
 * deployment contínuo.
 */
function textoIndicaPublicacao(texto: string): boolean {
  if (PADRAO_PUBLICACAO_INEQUIVOCA.test(texto)) {
    return true
  }
  if (!PADRAO_TOKEN_CD.test(texto)) {
    return false
  }
  return !PADRAO_VOCABULARIO_DE_VERIFICACAO.test(texto)
}

function nomeDoArquivo(caminho: string): string {
  return caminho.split('/').pop() ?? caminho
}

import { ambientesQueValem } from './ambiente-declarado.js'

export async function descobrirMecanismo(args: {
  /** Lê `GET /repos/{o}/{r}/environments`, devolvendo os nomes. */
  listarAmbientes: () => Promise<NomeDoAmbiente[]>
  /** Lê `GET /repos/{o}/{r}/actions/workflows`. */
  listarWorkflows: () => Promise<WorkflowDoRepositorio[]>
  /**
   * O que o PROJETO declarou como ambiente de publicação dele. Quando existe,
   * GANHA da descoberta — e ganha sem nem listar os ambientes do repositório.
   *
   * A descoberta olha o repositório inteiro e filtra o que parece efêmero, e
   * num caso real isso trouxe um ambiente de outra ferramenta (`copilot`) que
   * o aplicativo não tem permissão de ler: 992 leituras recusadas em 24 horas,
   * a publicação nunca confirmando, e seis entregas mescladas presas sem
   * fechar a tarefa. Adivinhar em repositório alheio não é confiável; o dono
   * do projeto sabe onde publica.
   */
  ambientesDeclarados?: string[] | undefined
  /** Onde o descompasso entre o declarado e o real é registrado. */
  onWarn?: ((mensagem: string) => void) | undefined
}): Promise<Mecanismo> {
  const ambientes = await args.listarAmbientes()

  // A declaração FILTRA o que é real — nunca substitui a leitura. Substituir
  // tinha dois buracos calados: nome declarado que não existe travava a
  // entrega para sempre ("nunca publicou" para uma publicação real), e o
  // produto perdia a chance de perceber um ambiente de produção esquecido.
  if (args.ambientesDeclarados && args.ambientesDeclarados.length > 0) {
    const cruzado = ambientesQueValem({
      declarados: args.ambientesDeclarados,
      reaisDoRepositorio: ambientes,
    })
    if (cruzado.naoEncontrados.length > 0) {
      args.onWarn?.(
        `ambiente declarado que não existe no repositório: ${cruzado.naoEncontrados.join(', ')}`
      )
    }
    if (cruzado.naoDeclarados.length > 0) {
      args.onWarn?.(
        `ambiente do repositório fora da declaração (não entra no veredito): ${cruzado.naoDeclarados.join(', ')}`
      )
    }
    // Nada do que foi declarado existe: a declaração está errada, e seguir com
    // ela deixaria a entrega presa para sempre. Cai na descoberta, que é o
    // comportamento de antes — pior que declarar, melhor que travar.
    if (cruzado.ambientes.length > 0) {
      return { tipo: 'deployment', ambientes: cruzado.ambientes }
    }
  }
  const ambientesDeclarados = ambientes.filter((a) => !PADRAO_AMBIENTE_EFEMERO.test(a))
  if (ambientesDeclarados.length > 0) {
    return { tipo: 'deployment', ambientes: ambientesDeclarados }
  }

  const workflows = await args.listarWorkflows()
  const workflowDePublicacao = workflows.find(
    (w) => w.ativo && (textoIndicaPublicacao(w.nome) || textoIndicaPublicacao(w.arquivo))
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
