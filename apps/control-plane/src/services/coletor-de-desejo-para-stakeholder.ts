import {
  lerArvoreDoPedido,
  type DepsDaArvoreDePedidos,
  type NoDaArvore,
} from './arvore-de-pedidos.js'
import type { DesejoParaMensagemDeStakeholder } from './mensagem-de-stakeholder.js'

/**
 * D76b (T10) — conta fases/épicos/features/tarefas DE VERDADE a partir da
 * árvore que já existe no GitHub (fase→épico→feature→task, pendurada como
 * sub-issues por `addSubIssue`/backlog-executor.ts). Reaproveita
 * `lerArvoreDoPedido` (arvore-de-pedidos.ts) — a MESMA leitura que o painel
 * do owner já usa para desenhar a árvore — em vez de bater na API GraphQL de
 * novo aqui: uma segunda função lendo a mesma coisa é um segundo lugar para
 * os dois divergirem, o mesmo defeito que "a árvore mostrando exemplo em vez
 * do dado real" já ensinou a evitar neste projeto.
 *
 * Contagem por nível FIXO (mesma forma em todo pedido):
 *   nível 0 = fases    → o próprio retorno de `lerArvoreDoPedido`
 *   nível 1 = épicos   → filhos de cada fase
 *   nível 2 = features → filhos de cada épico
 *   nível 3 = tarefas  → filhos de cada feature
 *
 * Conta pelos FILHOS QUE A CONSULTA REALMENTE TROUXE (`filhos.length`),
 * nunca por `partes.total` (que PODE ser maior quando o teto de nós da
 * consulta cortou um nível — ver o comentário de `NoDaArvore.partes` em
 * arvore-de-pedidos.ts): preferir um total não conferido pelos filhos
 * fetchados seria outra forma de "fingir que viu tudo". Nos tetos atuais
 * (20 fases × 20 épicos × 20 features × 50 tarefas) um pedido real não bate
 * nesse limite.
 */
export interface ArgsDoColetorDeDesejo {
  ownerId: string
  /** Nome do projeto (o campo `nome`, não "owner/repo") — mesmo formato que
   *  `lerArvoreDoPedido` já usa. */
  projeto: string
  /** Número da issue do desejo no GitHub. */
  numero: number
  /** O NOME do desejo — citado na mensagem de stakeholder pelo nome (D76b),
   *  nunca só o número interno da issue. Quem chama decide o título (ex.: o
   *  título da própria issue do desejo); este coletor não o inventa. */
  titulo: string
  /**
   * A prioridade que o dono deu a este desejo. Hoje NENHUM lugar do produto
   * guarda essa informação: os chips P0/P1/P2 de `TelaPedidos.tsx`
   * (estado local `pri`/`setPri`) nunca saem do componente —
   * `enviarPedido` (painel-api.ts) manda só `{projectId, texto}` para
   * `POST /api/v1/desejos`, e a rota (`routes/desejos.ts`) não lê nenhum
   * campo de prioridade do corpo (confirmado por leitura direta, D76b/T10 —
   * os achados anteriores L3-T8/"peso no quadro" e a suposição de uma
   * "prioridade do painel" enviada ao card são DUAS COISAS DIFERENTES: o
   * peso da issue HOJE chega ao quadro via `.setWeight()`, já testado em
   * `github-backlog-peso.test.ts`/`po-rails-mission.test.ts` — mas a
   * PRIORIDADE que o dono escolhe ao criar o desejo nunca sai da tela).
   * Quem chama este coletor passa `null` aqui até essa fonte existir de
   * verdade — nunca um número inventado.
   */
  prioridade: number | null
  /** Sprints estimadas para este desejo. Mesma regra: sem fonte hoje no
   *  produto — quem chama passa `null` até existir uma estimativa real. */
  sprintsEstimadas: number | null
}

function contarNiveisAbaixoDeFase(fases: readonly NoDaArvore[]): {
  epicos: number
  features: number
  tarefas: number
} {
  let epicos = 0
  let features = 0
  let tarefas = 0
  for (const fase of fases) {
    epicos += fase.filhos.length
    for (const epico of fase.filhos) {
      features += epico.filhos.length
      for (const feature of epico.filhos) {
        tarefas += feature.filhos.length
      }
    }
  }
  return { epicos, features, tarefas }
}

/**
 * O coletor real: busca a árvore do desejo no GitHub (via
 * `lerArvoreDoPedido`, a mesma leitura de produção) e devolve as contagens
 * prontas para `montarMensagemDeStakeholder`. Erros de leitura (rede,
 * credencial, pedido inexistente) SOBEM sem mascarar — `lerArvoreDoPedido`
 * já lança `ArvoreIndisponivelError`/`PedidoNaoEncontradoError` para isso;
 * quem chama decide o que fazer (ex.: cair para um texto antigo).
 */
export async function coletarDesejoParaMensagemDeStakeholder(
  args: ArgsDoColetorDeDesejo,
  deps: DepsDaArvoreDePedidos
): Promise<DesejoParaMensagemDeStakeholder> {
  const fases = await lerArvoreDoPedido(deps, {
    ownerId: args.ownerId,
    projeto: args.projeto,
    numero: args.numero,
  })
  const { epicos, features, tarefas } = contarNiveisAbaixoDeFase(fases)

  return {
    titulo: args.titulo,
    prioridade: args.prioridade,
    fases: fases.length,
    epicos,
    features,
    tarefas,
    sprintsEstimadas: args.sprintsEstimadas,
  }
}
