import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  ISSUE_DOD_FIELDS,
  formatQaReconDeliverable,
  type QaVerdictForm,
  type QaReconForm,
} from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import { GithubExecutionError } from './github-errors.js'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { aplicarLabelDoAgente } from './agent-label.js'
import type { CardMover } from './board-status.js'
import { ehPrDelegado } from './pr-delegado.js'
import type { LinhaDeSessao } from './dev-session-store.js'
import { lerDiffDoPr, type ArquivoDoPr } from './diff-do-pr.js'
import { mesclarPr, type ResultadoDoMerge } from './merge-do-pr.js'
import { decidirSobreVerificacao, type EstadoDaVerificacao } from './vigia-da-verificacao.js'
import { hashDaMensagem } from './session-watch.js'
import { fetchComTeto } from './fetch-com-teto.js'
import {
  acharParecerNesteHead,
  ehAprovacao,
  ehParecerSemPoderDeMesclar,
  foiJulgadoComCiVermelho,
  MARCA_SEM_PODER_DE_MESCLAR,
  MARCA_DE_REPROVACAO_CONDICIONAL,
  MARCA_JULGADO_COM_CI_VERMELHO,
  MARCA_DE_LEGADO_REJULGADO,
  temMarcaDeRejulgamentoDeLegado,
  MARCA_DE_APROVACAO,
  MARCA_DO_PARECER,
} from './parecer-do-qa.js'
import {
  decidirSobreOProjeto,
  pedidoDeDividirAEntrega,
  MARCA_DE_ENTREGA_GRANDE_DEMAIS,
  type EntregaJulgada,
} from './reprovacao-que-ensina.js'
import { ciTerminouVerde, estadoDoCi } from './estado-da-verificacao-do-github.js'
import { decidirSobreLegado } from './rejulgar-legados.js'

// Missão do QA nos TRILHOS (F3.6): acha a PR do Jules que precisa de julgamento,
// monta o snapshot (diff + Verification Criteria da issue + estado do CI), o
// motor preenche UM formulário de veredito, e o SISTEMA posta a review e — se
// for rework — o comentário mencionando @jules. A LLM nunca toca no GitHub.

// As duas marcas e a leitura de "já tem parecer neste head" mudaram de casa
// (parecer-do-qa.ts) quando o acordar do SM passou a precisar EXATAMENTE da
// mesma regra para levantar a fila de julgamento. Duas cópias divergiriam, e
// a divergência apareceria como missão de julgamento acordada para uma
// entrega que este laço vai pular. Os nomes locais continuam por serem os
// usados no resto do arquivo.
const JULES_MARKER = MARCA_DO_PARECER

/**
 * Tarefa 10: teto de tentativas de mescla SEGUIDAS contra o MESMO commit.
 * Um conflito de código (ou uma regra de proteção do ramo) é trabalho para o
 * dev resolver, não algo que o produto vai destravar tentando de novo a cada
 * tique do relógio para sempre. No fracasso número `MAX_TENTATIVAS_DE_MERGE`
 * o dono é avisado com o motivo que o GitHub devolveu, e a entrega para de
 * ser reprocessada até o commit mudar (ver `retomandoAprovacaoMesmoCommit`
 * mais abaixo).
 */
export const MAX_TENTATIVAS_DE_MERGE = 3

/**
 * Família de opções que só faz sentido ligada ao Prisma/notificador real do
 * dono — em produção, SEMPRE montada por `montarOpcoesDoJulgamento`
 * (scheduler.ts), nunca escrita à mão em outro call site.
 *
 * Guarda estrutural criada depois de esta família falhar de ligar DUAS vezes
 * seguidas (Tarefa 7: `registrarPendencia`/`limparPendencia`/
 * `registrarAvisoDeDemora`/`avisarDono` ficaram inertes; Tarefa 10:
 * `registrarFracassoDeMerge` repetiu o mesmo furo). As opções eram
 * ADICIONADAS aqui e nunca chegavam ao call site real — a lógica ficava
 * correta e testada em isolamento, e inerte em produção, porque sendo
 * opcionais o compilador não via nada de errado em omiti-las.
 *
 * Por isso este grupo agora vive numa interface PRÓPRIA: o tipo de retorno
 * de `montarOpcoesDoJulgamento` é `Required<Omit<VigiliaDoJulgamentoOptions,
 * 'avisarDono'>> & ...` — DERIVADO desta declaração, não uma lista de nomes
 * copiada à mão em outro lugar. Um campo novo aqui vira, automaticamente,
 * obrigatório no retorno daquela função — esquecer de ligá-lo quebra a build
 * (`pnpm --filter @gitorch/control-plane build`), não fica em silêncio até
 * alguém notar em produção. Ver `montarOpcoesDoJulgamento` em scheduler.ts.
 */
export interface VigiliaDoJulgamentoOptions {
  /**
   * Tarefa 7: grava a PRIMEIRA vez que esta entrega é vista com a
   * verificação pendente. Sem isto o teto de espera (`TETO_DE_ESPERA_MS`,
   * vigia-da-verificacao.ts) não tem de onde contar — a decisão de esperar
   * continua correta, só nunca amadurece para o aviso de demora.
   */
  registrarPendencia?: (args: { sessionName: string; agora: Date }) => Promise<void>
  /**
   * Tarefa 7: apaga a marca de pendência. Chamada de dentro deste mesmo laço
   * (R2 do controlador), no instante em que a verificação deixa de estar
   * pendente — nunca por um gatilho externo nem por uma varredura própria.
   */
  limparPendencia?: (args: { sessionName: string }) => Promise<void>
  /**
   * Avisa o dono quando a verificação de um PR fica parada além do teto de
   * espera. MESMO caminho que `session-watch.ts` usa (`VigiaDeps.avisarDono`)
   * — não é uma segunda campainha, é o mesmo aviso.
   *
   * A ÚNICA opção da família legitimamente ausente às vezes: sem notificador
   * (Telegram) configurado, não há para onde avisar — omitida de propósito,
   * por isso fica de fora do `Required<Omit<...>>` do retorno da função.
   */
  /**
   * Os julgamentos anteriores deste repositório, do mais recente para o mais
   * antigo. Alimenta a decisão de "este projeto está travado". Ausente = a
   * escalada não acontece, e o comportamento é o de sempre.
   */
  lerHistoricoDoProjeto?: (repositorio: string) => Promise<EntregaJulgada[]>
  /** Guarda ESTE julgamento para as próximas contas. */
  registrarJulgamento?: (args: { repositorio: string; peloPortao: boolean }) => Promise<void>
  avisarDono?: (mensagem: string) => Promise<void>
  /**
   * Achado 2 da revisão da Tarefa 7: grava que o dono já foi avisado desta
   * verificação parada, PARA ESTE COMMIT. Sem isto, `avisarDono` dispara a
   * cada tick do scheduler (~1min) enquanto a verificação continuar parada —
   * o dono seria avisado a cada minuto, para sempre, depois do teto. Mesma
   * disciplina de `session-watch.ts` ("SPAM apaga sinal tanto quanto
   * silêncio"), reaproveitando o MESMO campo (`answeredHash`, ver
   * `LinhaDeSessao`) e a mesma função de hash (`hashDaMensagem`).
   */
  registrarAvisoDeDemora?: (args: { sessionName: string; hash: string }) => Promise<void>
  /**
   * Tarefa 10: grava quantos fracassos de mescla SEGUIDOS já aconteceram
   * contra o commit atual desta entrega. `contador` já vem PRONTO de quem
   * chama — zerado e recomeçado em 1 se o commit mudou desde o último
   * fracasso, somado ao anterior se é o mesmo commit tentando de novo — esta
   * função só persiste o número final (mesmo espírito de `registrarPr`: o
   * dado já resolvido chega, o depósito não reinterpreta nada).
   *
   * Sem isto o teto (`MAX_TENTATIVAS_DE_MERGE`) nunca teria de onde contar:
   * a exceção do C1 (aprovação-ainda-aberta é reprocessada, não pulada)
   * reprocessaria para sempre, sem nunca acionar o aviso ao dono.
   */
  registrarFracassoDeMerge?: (args: {
    sessionName: string
    contador: number
    agora: Date
  }) => Promise<void>
}

export interface QaRailsMissionOptions extends VigiliaDoJulgamentoOptions {
  repository: string
  githubToken: string
  execute: (prompt: string) => Promise<string>
  contextBlocks?: string[]
  /**
   * Move o card da issue vinculada no board quando o veredito é rework
   * (opcional). Leva B: aprovação NÃO move mais o card para "done" por
   * aqui — isso só acontece quando a publicação confirma (ou o repositório
   * prova que não publica), em `resolverEntregaDoBoard` (scheduler.ts).
   */
  moveCard?: CardMover
  /** Label de delegação que marca trabalho de dev assíncrono (padrão 'jules'). */
  delegateLabel?: string
  /**
   * 'recon' = Fase 1 do QA (a fase de Reconhecimento do papel): projeto novo,
   * sem PR para julgar ainda. Em vez do no-op clássico, roda o roteiro de
   * reconhecimento e devolve o baseline de qualidade do repositório. Sem este
   * modo, o padrão é o caminho clássico (julgamento de PR; sem PR = no-op).
   */
  mode?: 'judge' | 'recon'
  fetchImpl?: typeof fetch
  /**
   * Linhas de sessão deste projeto — a forma autoritativa de reconhecer o PR
   * e, quando o PR ainda não foi gravado na linha (ver o aviso de reprovação
   * mais abaixo), de achar a sessão pela issue de origem. Espera-se ordenada
   * por `createdAt` decrescente (mais recente primeiro) — é assim que o
   * scheduler entrega, e é o que garante achar a linha viva quando há mais
   * de uma para a mesma issue.
   */
  sessoes?: LinhaDeSessao[]
  /**
   * Entrega a reprovação à sessão do dev assíncrono.
   *
   * Sem isto o laço não fecha: o veredito vira comentário no PR e o dev, que não
   * lê o PR dele, nunca fica sabendo. Medido: o PR #79 ficou 5 dias aberto, com
   * verificação verde e uma reprovação, sem ninguém retrabalhar. A API não tem
   * retomada — `sendMessage` é o único caminho.
   */
  avisarSessao?: (args: { sessionName: string; texto: string }) => Promise<boolean>
  /**
   * Guarda o pedido de retrabalho que NÃO chegou ao dev, para a vigília
   * reentregar. Sem isto, um erro passageiro do serviço externo encalha a
   * entrega para sempre — o parecer já foi postado, então a passagem seguinte
   * pula a entrega como "já julgada" e ninguém nunca mais tenta.
   */
  registrarAvisoPendente?: (args: { sessionName: string; texto: string }) => Promise<void>
  /**
   * Avisa que o PR foi mesclado de verdade — com o SHA do commit que o
   * GitHub de fato criou (`sha` da resposta de `PUT .../merge`, capturado
   * abaixo, NUNCA `pr.head.sha`: depois de um squash, o head da PR nunca
   * existe no branch base, e é o branch base que o CD publica).
   *
   * Tarefa 17: antes, quem chamava fechava a linha da vigia aqui mesmo
   * (`fecharSessao` com `'merged'`) — a sessão "concluía" no instante do
   * merge e o produto nunca soube se aquele código chegou ao ar. Agora quem
   * chama só GRAVA o commit mesclado (`registrarMescla`, dev-session-store.ts);
   * quem fecha a linha é a vigília da publicação (`varrerPublicacoes`,
   * scheduler.ts), quando há veredito. Este módulo continua sem saber nada
   * de banco — só entrega o fato de que a mescla aconteceu, e com qual commit.
   *
   * `issueNumber` (Importante 4 da revisão final da branch): a MESMA issue
   * de origem (`issueDaEntrega`, resolvida pelo laço de descoberta acima)
   * que este módulo já usa como recuo para achar `linhaDaEntrega` quando o
   * número do PR ainda não foi gravado na linha. `aoMesclarUmaEntrega`
   * (scheduler.ts) buscava SÓ pelo número do PR e desistia em silêncio —
   * este campo permite o MESMO recuo do outro lado da fronteira.
   */
  aoMesclar?: (args: {
    numeroDoPr: number
    mergeCommitSha: string
    issueNumber: number | null
  }) => Promise<void>
  /**
   * Canal do aviso de degradação — antes hardcoded em `console.warn`,
   * invisível na observabilidade estruturada. Produção (scheduler.ts) sempre
   * passa `app.log.warn`. Default: console.warn (só pra chamadas fora do
   * plugin).
   *
   * Não é preciosismo: este é justamente o aviso que existe para o veredito
   * não morrer em silêncio quando a sessão do dev não pôde ser avisada. Se ele
   * escapa do logger, o silêncio volta pela porta dos fundos. Mesmo motivo já
   * registrado em `github-app-token.ts`.
   */
  /**
   * Voltar a julgar (e comentar em) entrega que o produto NÃO encomendou.
   *
   * Desligado por decisão do dono em 25/08/2026, que supersede a regra antiga
   * de "julga todos, mescla só o delegado". Fica aqui para a volta ser uma
   * linha de configuração, e não uma arqueologia de código apagado.
   */
  julgarEntregaDeTerceiro?: boolean | undefined
  onWarn?: (message: string) => void
}

export interface QaRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  /**
   * Task 8 (decisão do dono: "julga todos, mescla só o que delegou"):
   * elegibilidade de merge da entrega julgada nesta chamada — espelha
   * `ehPrDelegado`, INDEPENDENTE do veredito (aprovar ou não é uma pergunta;
   * poder mesclar é outra). `undefined` quando nenhuma entrega foi julgada
   * (no-op, recon, ou vigília ativa esperando a verificação). A Tarefa 9 usa
   * este campo para travar o merge por fora deste módulo — separar "julgar"
   * de "poder mesclar" em dois campos é exatamente o que evita repetir o
   * quase-acidente do PR #99 (citação de issue confundida com entrega).
   */
  podeMesclar?: boolean
}

/** Comentário de rework estruturado (8 campos) mencionando @jules. */
export function buildJulesReworkComment(comment: QaVerdictForm['comment']): string {
  // Mesmo contrato da issue (padrão Shrimp): o rework que o QA devolve tem de
  // ser lido com a mesma régua com que a task foi escrita.
  const map: Record<string, string> = {
    Goal: comment.goal,
    'Task Details': comment.taskDetails,
    'Task Description': comment.taskDescription,
    'Implementation Guide': comment.implementationGuide,
    'Verification Criteria': comment.verificationCriteria,
    Dependencies: comment.dependencies,
    'Related Files': comment.relatedFiles,
    Notes: comment.notes,
  }
  const sections = ISSUE_DOD_FIELDS.map((h) => `## ${h}\n\n${map[h] ?? ''}`)
  return [
    `${JULES_MARKER}`,
    '@jules the PR needs changes before it can be approved:',
    '',
    ...sections,
  ].join('\n\n')
}

/** Quando a review foi publicada. `null` quando o GitHub não disse. */
function dataDaReview(review?: { submitted_at?: string } | null): Date | null {
  const cru = review?.submitted_at
  if (!cru) return null
  const d = new Date(cru)
  return Number.isFinite(d.getTime()) ? d : null
}

export async function runQaMissionViaRails(
  options: QaRailsMissionOptions
): Promise<QaRailsMissionResult> {
  // IMPORTANTE (leva D): alcançável pelo tique (scheduler.ts, wake do QA)
  // sob `tickEmAndamento` — mesma classe de defeito do Crítico. `mesclarPr`
  // e `lerDiffDoPr` recebem esta MESMA `gh` injetada (ver mais abaixo), então
  // ganham o teto de graça, sem precisar de mudança própria.
  const f = fetchComTeto(options.fetchImpl ?? fetch)
  const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const resp = await f(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${options.githubToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gitorch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!resp.ok) {
      // O corpo da resposta é o diagnóstico (ex.: 422 "Can not approve your
      // own pull request") — sem ele, o erro é um número mudo.
      const detail = await resp.text().catch(() => '')
      throw new GithubExecutionError(
        `GitHub ${method} ${path} failed (${resp.status}): ${detail.slice(0, 200)}`
      )
    }
    return resp.json().catch(() => ({}))
  }

  // 1) PRs abertas do repositório (o gatilho do QA). Task 8 (decisão do
  // dono: "julga todos, mescla só o que delegou"): o filtro que descartava
  // aqui, na origem, qualquer PR que `ehPrDelegado` não reconhecesse como
  // entrega do dev assíncrono SAIU — o QA agora examina toda PR aberta,
  // delegada ou de humano, e carrega o veredito de `ehPrDelegado` como
  // `delegado` para cada uma. O AUTOR não é sinal confiável — visto em
  // produção: o Jules abre o PR pela conta do dono da instalação. O sinal
  // nativo do GitOrch é o PR fechar uma issue com a label de delegação; o
  // login com "jules" fica só como atalho. Quem decide se a entrega PODE ser
  // mesclada não é mais este laço de descoberta — é o ponto do merge, mais
  // abaixo, guardado por `delegado`.
  const delegateLabel = options.delegateLabel ?? 'jules'
  const prs = (await gh(
    'GET',
    `/repos/${options.repository}/pulls?state=open&sort=created&direction=desc&per_page=20`
  )) as Array<{
    number: number
    user?: { login?: string }
    draft?: boolean
    body?: string
    head?: { sha?: string }
  }>
  let target: (typeof prs)[number] | undefined
  let issueDaEntrega: number | null = null
  let delegado = false
  // Tarefa 10: true quando o PR escolhido já tinha uma aprovação NOSSA
  // marcada NESTE MESMO head — ou seja, esta passagem está RETOMANDO uma
  // mescla que falhou antes, não abrindo julgamento novo. É o que diferencia
  // "contar mais um fracasso sobre o mesmo commit" de "commit novo, começar
  // do zero" na hora de gravar `mergeFailures` mais abaixo.
  let retomandoAprovacaoMesmoCommit = false
  /** Este ciclo é o rejulgamento único de uma entrega presa por régua velha. */
  let retomouLegado = false
  for (const p of Array.isArray(prs) ? prs : []) {
    if (p.draft) continue

    // A consulta à issue só acontece quando há palavra de ligação no corpo —
    // o caminho autoritativo (linha guardada) não gasta chamada nenhuma, e
    // uma PR de humano sem menção nenhuma também não gasta.
    const etiquetasPorIssue = new Map<number, boolean>()
    const ligada = (p.body ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
    if (ligada) {
      const issue = (await gh('GET', `/repos/${options.repository}/issues/${ligada}`)) as {
        labels?: Array<{ name?: string }>
      }
      etiquetasPorIssue.set(
        Number(ligada),
        (issue.labels ?? []).some((l) => l.name === delegateLabel)
      )
    }

    const veredito = ehPrDelegado({
      numeroDoPr: p.number,
      autor: p.user?.login,
      corpo: p.body,
      sessoes: options.sessoes ?? [],
      issueComEtiquetaDeDelegacao: (n) => etiquetasPorIssue.get(n) ?? false,
    })

    // ENTREGA QUE O PRODUTO NÃO ENCOMENDOU SAI AQUI — decisão do dono
    // (25/08/2026), palavras dele: "QA tem que acordar apenas naquilo que o
    // Gitorch esta trabalhando... nao tem pq o QA comentar num PR que nao
    // esta sendo atuado".
    //
    // Antes o QA julgava TODA entrega aberta do repositório e ainda comentava
    // na de terceiro, avisando que não ia mesclar. Medido: 662 acordadas em
    // pouco mais de um dia, 87% voltando vazias — boa parte varrendo entrega
    // alheia. Isso é opinião não pedida no pull request de outra pessoa, e
    // custo de motor por cada uma.
    //
    // O corte fica ANTES de ler as reviews de propósito: é a chamada mais
    // cara do laço, e a entrega de terceiro não precisa dela para nada.
    //
    // O dono disse "pode ser que mude depois", então o caminho antigo não foi
    // apagado — vive atrás de `julgarEntregaDeTerceiro`, e volta com uma
    // linha de configuração.
    if (!veredito.delegado && !options.julgarEntregaDeTerceiro) continue

    // Não re-julgar o MESMO estado a cada wake: se já há review nossa neste
    // head, a entrega já recebeu parecer — julgar de novo só faria spam de
    // opinião duplicada. Vale para QUALQUER entrega, delegada ou de humano.
    //
    // C1 (revisão final): EXCETO quando a entrega é DELEGADA e essa review
    // marcada é uma APROVAÇÃO. Aprovação postada + PR ainda ABERTO (este laço
    // só olha PRs `state=open`) é PROVA de que o merge não aconteceu — o
    // GitHub recusou (405, proteção de branch) ou o produto não pôde aprovar
    // a própria PR e a review virou COMMENT. Tratar isso como "já julgado"
    // era um beco sem saída permanente: a linha da sessão nunca fecha, a
    // issue nunca volta à fila, e a vigia dispara o QA para sempre sem nunca
    // reentar o merge — o defeito das 85 execuções cegas ressuscitado. Um PR
    // REPROVADO cujo dev ainda não retrabalhou continua pulado normalmente:
    // é o que evita spam de re-julgamento.
    //
    // Task 8: essa reexaminação por aprovação-ainda-aberta só faz sentido
    // para quem PODE ser mesclado — uma entrega de humano "aprovada" pelo QA
    // nunca vai ser mesclada por este produto, então ficaria aberta para
    // sempre e seria reexaminada (e re-opinada) a cada ciclo, virando o
    // mesmo spam que esta guarda existe para evitar. Para humano, qualquer
    // review marcada — aprovação ou não — já é "julgado, ponto final".
    const reviews = (await gh(
      'GET',
      `/repos/${options.repository}/pulls/${p.number}/reviews?per_page=100`
    )) as Array<{ body?: string; commit_id?: string }>
    // Item 2 (leva B2): a API devolve as reviews da MAIS ANTIGA para a MAIS
    // NOVA — por isso a busca varre de trás para frente, para achar a ÚLTIMA
    // review nossa marcada neste head, nunca a primeira. Mais de uma review
    // nossa pode existir no MESMO head sem push novo: uma aprovação seguida,
    // dias depois, de um "pedir mudanças" quando a verificação vira vermelha
    // no MESMO commit (a trava determinística, mais abaixo, baixa o veredito
    // para `request_changes` sem nunca chamar o GitHub para mesclar). Com
    // `.find` (mais antiga primeiro) isto era um beco sem saída: a review
    // encontrada continuava sendo a aprovação ORIGINAL, `foiAprovacao` ficava
    // `true` para sempre, e a entrega era reprocessada a cada tique —
    // motor acionado, duas postagens no PR do cliente — sem NUNCA chamar o
    // GitHub para mesclar (a verificação vermelha impede isso por desenho), e
    // por isso sem NUNCA avançar `mergeFailures` (que só conta fracasso
    // quando o GitHub é de fato chamado, Tarefa 10) — o teto de
    // `MAX_TENTATIVAS_DE_MERGE` nunca era alcançado. Lendo a review MAIS
    // RECENTE, a segunda passagem já vê o "pedir mudanças" como o estado
    // atual, `foiAprovacao` vira `false`, e a entrega passa a ser tratada
    // como "já julgada" (pulada) — o mesmo desfecho de qualquer outra
    // reprovação, sem laço sem fim.
    const reviewMarcadaNesteHead = acharParecerNesteHead(reviews, p.head?.sha)
    const foiAprovacao = ehAprovacao(reviewMarcadaNesteHead)

    // Tarefa 10: a exceção do C1 acima (reprocessar aprovação-ainda-aberta em
    // vez de pular) não pode reprocessar PARA SEMPRE — um conflito de código
    // real nunca desaparece sozinho, e sem teto o produto tentaria mesclar a
    // cada tique do relógio, gerando uma review nova e um PUT .../merge novo
    // toda vez, sem nunca avisar ninguém. `mergeFailures` da linha da sessão
    // (mesma que decide "delegado" acima) é o que sabia quantos fracassos
    // SEGUIDOS já aconteceram contra o commit atual — acima do teto, a
    // entrega volta a ser tratada como "já julgada" (pulada) até o dev
    // empurrar um commit novo, que muda `p.head.sha` e derruba
    // `reviewMarcadaNesteHead` de qualquer forma (ver comentário do achado
    // acima sobre `head NOVO`).
    const linhaCandidata =
      (options.sessoes ?? []).find((s) => s.pullRequestNumber === p.number) ??
      (veredito.issueNumber !== null
        ? (options.sessoes ?? []).find((s) => s.issueNumber === veredito.issueNumber)
        : undefined)
    const aindaPodeTentarMesclar = (linhaCandidata?.mergeFailures ?? 0) < MAX_TENTATIVAS_DE_MERGE

    // A SEGUNDA exceção ao skip, e ela desfaz um beco sem saída PERMANENTE.
    //
    // O parecer emitido na janela cega saiu como comentário porque, naquele
    // instante, o produto não sabia que a entrega era sua. Se a ligação chegou
    // DEPOIS — e com o reconhecimento em quatro segundos ela chega —, aquele
    // parecer foi emitido sob premissa errada: dizia, no pull request do
    // cliente, que a entrega "não foi encomendada pelo produto", sobre um
    // trabalho que o produto encomendou.
    //
    // Sem esta linha, o laço trata aquele parecer como julgamento final e pula
    // a entrega para sempre. O pull request fica aberto, com verificação
    // verde, esperando uma aprovação formal que nunca vem — e o portão do
    // repositório, que exige APPROVED, segura o merge indefinidamente sem
    // nunca ficar vermelho. Ninguém percebe.
    //
    // O teto de tentativas continua valendo: rejulgar sob premissa corrigida é
    // legítimo uma vez, não é licença para tentar mesclar a cada tique.
    // A LIGAÇÃO tem que ser a de VERDADE: a linha da sessão apontando para
    // ESTE pull request. `veredito.delegado` sozinho não serve aqui, e a
    // diferença é grave.
    //
    // `ehPrDelegado` tem um ramo mais frouxo que aceita "corpo cita Fixes #N +
    // issue etiquetada + existe ALGUMA sessão para aquela issue". Para
    // decidir se vale opinar, isso basta. Para REABRIR um parecer já
    // publicado, não: um humano que abrisse um PR citando `Fixes #74` como
    // referência receberia o parecer com a promessa escrita — "NÃO vou
    // mesclá-lo, a decisão é sua" — e, assim que o SM delegasse a issue #74 a
    // sério, o produto rejulgaria o PR DELE, aprovaria formalmente e chamaria
    // o merge. Mesclaria o pull request que prometeu publicamente não
    // mesclar, no repositório do cliente.
    //
    // Exigir `pullRequestNumber === p.number` é justamente o que dá nome a
    // este conserto: a ligação que chegou depois é a sessão apontando para o
    // PR, não um palpite pelo corpo.
    const ligacaoApontaParaEstePr = linhaCandidata?.pullRequestNumber === p.number
    const parecerSobPremissaErrada =
      veredito.delegado &&
      ligacaoApontaParaEstePr &&
      ehParecerSemPoderDeMesclar(reviewMarcadaNesteHead)

    // A TERCEIRA exceção: a reprovação que veio do PORTÃO, não do código.
    //
    // Quando o motor aprova mas a verificação não está verde, a trava
    // determinística rebaixa o veredito para "pedir mudanças". A trava está
    // certa. O que faltava era a VOLTA: se a verificação fica verde depois no
    // MESMO commit — reexecução, teste instável que passou na segunda,
    // conserto de infraestrutura —, o motivo da reprovação deixou de existir e
    // ninguém voltava atrás.
    //
    // Isso travou um projeto inteiro. Medido em 23/08/2026: zero entregas
    // mescladas em treze sessões no loureng/patinhas-3d-crafts, com pull
    // requests de CI verde parados. O #3768 estava CLEAN, verificação inteira
    // verde, e a única review nossa no head era um "pedir mudanças" emitido
    // quando o CI ainda estava vermelho.
    //
    // A CONDIÇÃO É O CI ESTAR VERDE AGORA, e é ela que impede o laço: com a
    // verificação ainda vermelha, o rejulgamento produziria a mesma reprovação
    // e postaria outra review no pull request do cliente, a cada ciclo. Custa
    // uma chamada por entrega nesta situação — poucas, e só enquanto durar.
    let reprovadoPeloPortaoComCiVerdeAgora = false
    if (
      veredito.delegado &&
      aindaPodeTentarMesclar &&
      foiJulgadoComCiVermelho(reviewMarcadaNesteHead) &&
      p.head?.sha
    ) {
      try {
        const checks = (await gh(
          'GET',
          `/repos/${options.repository}/commits/${p.head.sha}/check-runs`
        )) as { check_runs?: Array<{ conclusion?: string; status?: string }> }
        reprovadoPeloPortaoComCiVerdeAgora = ciTerminouVerde(checks.check_runs ?? [])
      } catch {
        // Não deu para saber o estado da verificação. Na dúvida, NÃO
        // rejulgar: reabrir um veredito sem saber se o motivo caiu seria
        // opinar duas vezes no pull request do cliente sem base.
        reprovadoPeloPortaoComCiVerdeAgora = false
      }
    }

    // O LEGADO: reprovação escrita ANTES de o produto passar a aceitar job
    // `skipped` como parte de um CI verde. Ela não tem — nem podia ter — a
    // marca do portão, porque a marca nasceu depois; e o corpo de uma
    // reprovação de CÓDIGO é idêntico ao de uma do portão, então ler o texto
    // não distingue as duas. A evidência é outra: mesmo commit, e verde pela
    // régua de HOJE. Uma vez só, e nunca depois do corte — senão isto viraria
    // segunda chance permanente, que é a trava que ninguém pode afrouxar.
    let legadoMereceUmaChance = false
    if (
      veredito.delegado &&
      aindaPodeTentarMesclar &&
      reviewMarcadaNesteHead &&
      !reprovadoPeloPortaoComCiVerdeAgora &&
      !foiAprovacao &&
      p.head?.sha
    ) {
      const decisao = decidirSobreLegado({
        numero: p.number,
        headAtual: p.head.sha,
        headJulgado: reviewMarcadaNesteHead.commit_id ?? null,
        reprovadaEm: dataDaReview(reviewMarcadaNesteHead),
        ciHoje: await (async () => {
          try {
            const checks = (await gh(
              'GET',
              `/repos/${options.repository}/commits/${p.head?.sha}/check-runs`
            )) as { check_runs?: Array<{ conclusion?: string; status?: string }> }
            return estadoDoCi(checks.check_runs ?? [])
          } catch {
            // Não saber o estado é "não sei", e "não sei" nunca destrava.
            return 'unknown' as const
          }
        })(),
        delegada: veredito.delegado,
        jaRejulgada: temMarcaDeRejulgamentoDeLegado(reviewMarcadaNesteHead),
      })
      legadoMereceUmaChance = decisao.acao === 'rejulgar'
      if (legadoMereceUmaChance) {
        options.onWarn?.(
          `[qa] PR #${p.number}: ${decisao.motivo} — dando o rejulgamento único do legado`
        )
      }
    }

    const deveRejulgar =
      veredito.delegado &&
      aindaPodeTentarMesclar &&
      (foiAprovacao ||
        parecerSobPremissaErrada ||
        reprovadoPeloPortaoComCiVerdeAgora ||
        legadoMereceUmaChance)

    if (reviewMarcadaNesteHead && !deveRejulgar) continue

    target = p
    issueDaEntrega = veredito.issueNumber
    delegado = veredito.delegado
    // Inclui a entrada pela reprovação do portão. Hoje `mergeFailures` está
    // garantidamente em zero quando esse caminho dispara — a marca do portão
    // só existe quando nenhum merge chegou a ser tentado naquele head —, então
    // é um no-op. Mas a invariante é frágil: bastaria mudar quando o merge é
    // tentado para isto virar subcontagem real de fracassos.
    // O legado entra aqui pelo MESMO motivo que a reprovação do portão: mesmo
    // commit, e nenhum merge chegou a ser tentado naquele ciclo. Deixá-lo de
    // fora zeraria o contador de fracassos e afrouxaria o teto de tentativas
    // justamente para os PRs mais antigos.
    retomandoAprovacaoMesmoCommit = Boolean(
      reviewMarcadaNesteHead &&
      (foiAprovacao || reprovadoPeloPortaoComCiVerdeAgora || legadoMereceUmaChance)
    )
    retomouLegado = legadoMereceUmaChance
    break
  }
  if (!target) {
    // Fase 1 — Reconhecimento: projeto novo, sem PR aberta ainda. Sem este
    // modo, a esteira de onboarding terminaria num no-op ("QA: no delegated
    // PR awaiting judgment.") sem aprender nada do repositório. Aqui o QA
    // aprende o repositório (CI, suítes, cobertura, caminhos críticos) ANTES
    // do primeiro PR chegar.
    if (options.mode === 'recon') {
      const prompt = buildStepPrompt('qa', 'qa-recon', RAILS_SCHEMAS.qaRecon, [
        ...(options.contextBlocks ?? []),
        'No delegated PR is open yet — this project was just onboarded to GitOrch.',
        'Your job now is RECONNAISSANCE, not judgment: learn this repository before ' +
          'the first PR arrives. Use the codegraph/context above to identify the CI ' +
          'tool in use, the test suites/frameworks that exist, what test coverage is ' +
          'expected of new code, and the critical paths that must never break.',
      ])
      const recon = (await runFormStep({
        schema: RAILS_SCHEMAS.qaRecon,
        prompt,
        execute: options.execute,
      })) as QaReconForm
      return {
        exitCode: 0,
        output: formatQaReconDeliverable(recon),
        stderr: '',
      }
    }
    return {
      exitCode: 0,
      output: 'QA: no delegated PR awaiting judgment.',
      stderr: '',
      noOp: true,
    }
  }

  // 2) Snapshot curado pelo SISTEMA: PR + issue vinculada + critérios + diff + CI.
  const pr = (await gh('GET', `/repos/${options.repository}/pulls/${target.number}`)) as {
    body?: string
    head?: { sha?: string }
  }

  // O ESTADO da verificação vem logo após buscar a PR — ANTES de gastar
  // chamadas com a issue vinculada e o diff — porque a decisão da Tarefa 6
  // (`decidirSobreVerificacao`, logo abaixo) pode mandar esperar; não há por
  // que buscar critérios e diff de um PR que não vai ser julgado agora.
  let ciState: EstadoDaVerificacao = 'unknown'
  if (pr.head?.sha) {
    const checks = (await gh(
      'GET',
      `/repos/${options.repository}/commits/${pr.head.sha}/check-runs`
    )) as { check_runs?: Array<{ conclusion?: string; status?: string }> }
    ciState = estadoDoCi(checks.check_runs ?? [])
  }

  // A linha da sessão desta entrega — usada AQUI pela decisão da verificação
  // (precisa saber desde quando ela está pendente) e mais abaixo, no ramo de
  // reprovação, para avisar o dev assíncrono. Calculada uma única vez.
  //
  // A linha pode ainda não ter o PR gravado: quem grava é a vigia, e ela
  // roda em outro ciclo. Medido em produção: o QA julgou o PR #97 pela
  // delegação achada no recuo do corpo ("Fixes #74") porque a linha guardada
  // ainda não tinha o PR, e a vigia só gravou `pullRequestNumber = 97`
  // minutos depois — buscando só por PR, o `find` não acharia nada, o mesmo
  // destino do PR #79 (5 dias parado sem aviso). A issue de origem o QA já
  // conhece neste instante (`issueDaEntrega`, resolvida no laço de
  // descoberta acima), então ela entra como SEGUNDA tentativa — não
  // substitui a busca por PR, que é inequívoca (um PR só tem uma linha) e
  // continua sendo a primeira. Quando `issueDaEntrega` é `null` (recuo por
  // login do autor — `ehPrDelegado` não tem como saber a issue nesse recuo),
  // só a busca por PR vale mesmo.
  //
  // `LinhaDeSessao` não expõe `closedAt` (só `dev-session-store.ts` grava; o
  // tipo devolvido aqui é deliberadamente estreito), então não há como
  // filtrar "só viva" dentro deste módulo. Em vez disso, `find` pega a
  // PRIMEIRA linha da issue na ordem em que `options.sessoes` chegou —
  // documentada acima como `createdAt` decrescente. O índice único parcial
  // `dev_sessions_open_per_issue` garante no máximo UMA sessão viva por
  // issue ao mesmo tempo, então a linha mais recente para essa issue É a
  // viva (ou a única candidata, se todas já fecharam) — resolve "prefira a
  // viva/mais recente" sem precisar do campo que o tipo não tem.
  const linhaDaEntrega =
    (options.sessoes ?? []).find((s) => s.pullRequestNumber === target.number) ??
    (issueDaEntrega !== null
      ? (options.sessoes ?? []).find((s) => s.issueNumber === issueDaEntrega)
      : undefined)

  // Defeito real de produção (PR #97): o QA julgou este PR ENQUANTO a
  // verificação ainda rodava (`ciState === 'pending'`), reprovou com "CI
  // pending", e minutos depois a verificação terminou 100% verde — mas a
  // reprovação ficou PRESA para sempre: o skip de "já julgado" (mais acima,
  // mesmo head sha) nunca deixa o QA re-julgar o mesmo estado, então um
  // motivo TRANSITÓRIO virou um bloqueio PERMANENTE. `pending` (e `unknown`
  // — não dá para ler check-runs sem o sha do head, e julgar sem saber
  // arrisca a mesma reprovação permanente por uma porta diferente) não são
  // veredito: são "ainda não sei".
  //
  // A correção original apenas pulava, calado, sempre — trocando um defeito
  // por outro: uma verificação que nunca termina prendia a entrega do mesmo
  // jeito, só que sem ninguém saber. `decidirSobreVerificacao` (Tarefa 6)
  // substitui o pulo cego por uma decisão: julgar quando há evidência
  // (`green`/`red`/`no checks` — este último é um estado ESTÁVEL, o
  // repositório não tem verificação e não passa a ter uma só de esperar, por
  // isso continua sendo julgado e virando a lacuna GITORCH-GAP, ver adiante),
  // esperar enquanto pendente, e avisar o dono quando a espera passa do teto
  // (`TETO_DE_ESPERA_MS`).
  const agora = new Date()
  const decisao = decidirSobreVerificacao({
    estado: ciState,
    primeiraVezVistoPendenteEm: linhaDaEntrega?.pendingSince ?? null,
    agora,
  })

  if (decisao.acao !== 'julgar') {
    // `esperar`: grava a PRIMEIRA vez que esta entrega foi vista pendente —
    // sem isso o teto não tem de onde contar. Quem garante "só a primeira
    // vez" é `registrarPendencia` (dev-session-store.ts): chamar de novo a
    // cada ciclo, enquanto a pendência continua, não regrava nada.
    if (decisao.acao === 'esperar' && linhaDaEntrega && options.registrarPendencia) {
      await options.registrarPendencia({ sessionName: linhaDaEntrega.sessionName, agora })
    }
    // `avisar-demora`: o MESMO aviso que `session-watch.ts` usa para o dono —
    // não uma segunda campainha. Best-effort: um aviso que falha não pode
    // travar a missão, mesmo espírito do aviso à sessão do dev mais abaixo.
    //
    // Achado 2 da revisão da Tarefa 7: o scheduler acorda a cada tick
    // (~1min), e sem uma marca de idempotência este `if` dispararia todo
    // tick, para sempre, depois do teto — SPAM apaga sinal tanto quanto
    // silêncio (mesma disciplina de `session-watch.ts`, ramo `investigar`).
    // O hash amarra o aviso ao COMMIT que está parado (`pr.head.sha`): se um
    // push novo mudar o head enquanto a verificação segue pendente, o hash
    // muda e o dono é avisado de novo — a situação mudou de verdade.
    if (decisao.acao === 'avisar-demora') {
      const hashDoAviso = hashDaMensagem(`avisar-demora:${pr.head?.sha ?? ''}`)
      const jaAvisado = linhaDaEntrega?.answeredHash === hashDoAviso
      if (!jaAvisado && options.avisarDono) {
        await options
          .avisarDono(
            `GitOrch: a verificação automática do PR #${target.number} (${options.repository}) ` +
              `está parada — ${decisao.motivo}.`
          )
          .catch(() => undefined)
        if (linhaDaEntrega && options.registrarAvisoDeDemora) {
          await options.registrarAvisoDeDemora({
            sessionName: linhaDaEntrega.sessionName,
            hash: hashDoAviso,
          })
        }
      }
    }
    return {
      exitCode: 0,
      output: `QA: PR #${target.number} não julgado — ${decisao.motivo}.`,
      stderr: '',
      noOp: true,
    }
  }

  // `julgar`: se esta entrega chegou a ficar marcada como pendente, a marca
  // sai AQUI — dentro do próprio laço do juiz, no mesmo instante em que a
  // decisão foi consultada. Nunca um gatilho externo, nunca uma varredura
  // própria (resolução R2 do controlador).
  if (linhaDaEntrega?.pendingSince && options.limparPendencia) {
    await options.limparPendencia({ sessionName: linhaDaEntrega.sessionName })
  }

  // A issue vinculada vem PRIMEIRO da linha guardada (autoritativa); só cai
  // para a palavra de ligação no corpo quando a delegação foi reconhecida
  // pelos recuos (login do autor ou etiqueta), que não sabem a issue de origem.
  const linkedIssue =
    issueDaEntrega !== null
      ? String(issueDaEntrega)
      : (pr.body ?? '').match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1]
  let criteria = '(no linked issue / Verification Criteria not found)'
  let linkedIssueLabels: string[] = []
  if (linkedIssue) {
    const issue = (await gh('GET', `/repos/${options.repository}/issues/${linkedIssue}`)) as {
      body?: string
      labels?: Array<{ name?: string }>
    }
    linkedIssueLabels = (issue.labels ?? [])
      .map((l) => l.name)
      .filter((name): name is string => Boolean(name))
    // A MESMA leitura que a fila de delegação usa para "Related Files" — uma
    // regra de parsing, um lugar só. Enquanto isto era uma expressão regular
    // solta aqui dentro, precisar dela para outro cabeçalho produziria uma
    // segunda cópia, e duas cópias divergem na primeira vez que o formato
    // muda.
    const achado = lerSecaoDaIssue(issue.body, 'Verification Criteria')
    if (achado) criteria = achado
  }
  const { diff, arquivos, truncado } = await lerDiffDoPr({
    buscarPagina: async (pagina) =>
      (await gh(
        'GET',
        `/repos/${options.repository}/pulls/${target.number}/files?per_page=100&page=${pagina}`
      )) as ArquivoDoPr[],
  })

  // 3) Roteiro do QA: um formulário de veredito.
  const prompt = buildStepPrompt('qa', 'qa-verdict', RAILS_SCHEMAS.qaVerdict, [
    ...(options.contextBlocks ?? []),
    `PR #${target.number} by ${target.user?.login}.`,
    `Verification Criteria (from linked issue #${linkedIssue ?? '?'}):\n${criteria}`,
    `CI status: ${ciState}. (You MUST NOT approve when CI is not green.)`,
    truncado
      ? `Diff: ${arquivos} file(s), TRUNCATED — you are NOT seeing the whole change. ` +
        `You MUST NOT approve on a truncated diff: if the criteria cannot be checked ` +
        `against what you can see, say so explicitly in your comment.\n${diff}`
      : `Diff (${arquivos} file(s), complete):\n${diff}`,
  ])
  const verdict = (await runFormStep({
    schema: RAILS_SCHEMAS.qaVerdict,
    prompt,
    execute: options.execute,
  })) as QaVerdictForm

  // Trava determinística: nunca aprovar com verificação não-verde nem sobre um
  // diff que não coube por inteiro. O sistema é o guarda final, não a leitura
  // do motor.
  //
  // `no checks` SAIU da lista de estados aceitáveis: ausência de verificação
  // não é aprovação. Ela vira lacuna registrada na memória do projeto (ver
  // adiante neste arquivo), para o RA fundamentar e o PO transformar em tarefa.
  const rebaixadoPeloPortao = verdict.verdict === 'approve' && (ciState !== 'green' || truncado)
  const effectiveVerdict = rebaixadoPeloPortao ? 'request_changes' : verdict.verdict

  // A reprovação que veio do PORTÃO carrega marca própria.
  //
  // Ela não diz nada sobre a qualidade da entrega: diz que, naquele instante,
  // a verificação não estava verde ou o diff não coube. Sem distinguir isso de
  // uma reprovação de código, o laço de descoberta trata as duas como
  // julgamento final e pula para sempre — e a entrega fica presa mesmo depois
  // de a verificação ficar verde no MESMO commit.
  //
  // Foi o que travou um projeto inteiro: zero entregas mescladas em treze
  // sessões, com pull requests de CI verde esperando um veredito que nunca
  // vinha.
  // A marca só sai quando a causa do rebaixamento foi EXCLUSIVAMENTE o CI.
  //
  // O rebaixamento tem duas causas — verificação não-verde e diff que não
  // coube. Marcar as duas igual criaria um laço sem fim, e a revisão pegou:
  // `truncado` é determinístico para o mesmo commit (mesmos arquivos, mesmo
  // resultado, sempre). Então o ciclo seria: rejulga porque o CI ficou verde →
  // o motor aprova → `truncado` continua verdadeiro → rebaixa de novo → posta
  // outra review → rejulga de novo, para sempre.
  //
  // E o teto de tentativas NÃO fecharia esse laço: `mergeFailures` só avança
  // quando o GitHub é de fato chamado para mesclar, o que nunca acontece
  // enquanto o veredito é rebaixado. Seria opinião repetida no pull request do
  // cliente, a cada tique, sem nada para segurar.
  //
  // Diff grande demais continua sendo reprovação FINAL: o dev tem o que fazer
  // — dividir a entrega. Verificação vermelha não: ali o dev não tem o que
  // consertar, e é por isso que só ela merece a volta.
  // A marca registra o ESTADO DA VERIFICAÇÃO, não quem decidiu.
  //
  // A versão anterior marcava só o REBAIXAMENTO — o caso em que o motor
  // aprovava e a trava determinística derrubava o veredito. Ler a saída real
  // mostrou que esse é o caminho MENOS comum: o comentário do julgamento no PR
  // #3768 diz "Resolve the CI failures (...) The current CI status is reported
  // as red", ou seja, o motor leu o vermelho e reprovou sozinho. E é o que
  // acontece quase sempre, porque o próprio prompt manda "You MUST NOT approve
  // when CI is not green" — ele obedece antes de a trava precisar agir.
  //
  // Marcando o estado, os dois caminhos ficam cobertos: não importa quem
  // decidiu, importa que a verificação estava vermelha naquele instante.
  //
  // `truncado` fica de fora de propósito. Diff que não coube é determinístico
  // para o mesmo commit, então reabrir por causa dele repetiria a mesma
  // reprovação para sempre — e o teto de tentativas não seguraria, porque ele
  // só avança quando o merge é de fato chamado. Diff grande continua sendo
  // reprovação final: ali o dev tem o que fazer, que é dividir a entrega.
  const julgadoComCiVermelho =
    effectiveVerdict === 'request_changes' && ciState === 'red' && !truncado
  const rebaixadoSoPeloCi = verdict.verdict === 'approve' && ciState !== 'green' && !truncado
  // Reprovação por TAMANHO ganha marca própria. Sem ela, quem lê o histórico
  // do repositório não distingue "esta entrega tem defeito" de "esta entrega
  // não coube" — e é essa distinção que faz a contagem de projeto travado
  // significar alguma coisa.
  // Carimba que o legado já teve a chance dele, para não voltar a cada
  // varredura. Vai no parecer NOVO, que é onde a próxima leitura procura.
  const marcaDoLegado = retomouLegado ? `\n${MARCA_DE_LEGADO_REJULGADO}` : ''
  const barradoPorTamanho = effectiveVerdict === 'request_changes' && truncado
  const marcaDoPortao = barradoPorTamanho
    ? `\n${MARCA_DE_ENTREGA_GRANDE_DEMAIS}`
    : julgadoComCiVermelho
      ? `\n${MARCA_JULGADO_COM_CI_VERMELHO}`
      : rebaixadoSoPeloCi
        ? `\n${MARCA_DE_REPROVACAO_CONDICIONAL}`
        : ''

  // O parecer que o dev consegue atender. Antes, a reprovação por tamanho saía
  // com "approval was blocked" e nada mais: ele procurava o defeito no código
  // dele e não achava, porque não havia.
  const explicacaoDoTamanho = barradoPorTamanho
    ? `\n\n${pedidoDeDividirAEntrega(target.number, arquivos)}`
    : ''

  // 4) Executor determinístico posta o veredito. O GitHub PROÍBE
  // aprovar/pedir-mudanças no PRÓPRIO PR (422) — e o Jules abre o PR pela
  // conta do dono da instalação, que é a mesma do token. Nesse caso o
  // veredito sai como review COMMENT (permitido), com o resultado explícito
  // no texto; o marker continua valendo para o skip de re-julgamento.
  // Antes daqui havia um `GET /user` para saber se o PR era do próprio ator —
  // o GitHub recusa (422) que alguém revise a própria PR. Só que a identidade
  // do GitOrch é a de um APLICATIVO, e aplicativo não é uma pessoa: `/user`
  // responde 403 "Resource not accessible by integration" SEMPRE, e a missão
  // do QA morria antes de postar qualquer veredito.
  //
  // Quem responde essa pergunta melhor que nós é o próprio GitHub: tenta com
  // força total e, se vier o 422, reposta como comentário — que é sempre
  // permitido. O veredito sai nos dois casos; o marcador continua valendo para
  // não re-julgar o mesmo estado.
  //
  // Achado A da revisão independente da Tarefa 8: aprovar FORMALMENTE
  // (`event: APPROVE`) uma entrega que o produto não encomendou reabre, por
  // outra porta, o mesmo risco que a regra do dono existe para fechar. Num
  // repositório cuja proteção de branch exige "1 approving review", a nossa
  // aprovação sozinha SATISFAZ essa exigência — o PR de humano vira mesclável
  // por qualquer pessoa, ou por qualquer automação de auto-merge, sem que um
  // humano de verdade tenha aprovado nada. Por isso a entrega NÃO delegada
  // nunca recebe evento formal de aprovação/reprovação: sai sempre como
  // COMMENT, com o parecer completo (e o aviso de "não vai mesclar",
  // `avisoDeNaoMesclar` abaixo) no corpo. A entrega delegada mantém
  // APPROVE/REQUEST_CHANGES exatamente como sempre foi.
  const reviewEvent = !delegado
    ? 'COMMENT'
    : effectiveVerdict === 'approve'
      ? 'APPROVE'
      : 'REQUEST_CHANGES'

  const postarReview = async (evento: string, corpo: string): Promise<boolean> => {
    try {
      await gh('POST', `/repos/${options.repository}/pulls/${target.number}/reviews`, {
        event: evento,
        body: corpo,
      })
      return false
    } catch (err) {
      const recusouProprioPr =
        err instanceof GithubExecutionError &&
        err.message.includes('(422)') &&
        /own pull request/i.test(err.message)
      if (!recusouProprioPr) throw err
      await gh('POST', `/repos/${options.repository}/pulls/${target.number}/reviews`, {
        event: 'COMMENT',
        body: `${corpo}\n\n_(publicado como comentário: o autor da PR é a própria identidade do GitOrch)_`,
      })
      return true
    }
  }

  // Task 11 (decisão do dono D7): o produto mescla sozinho desde o primeiro
  // ciclo, sem confirmação humana — não há dono para esse passo hoje, e
  // represar para confirmação foi proposto e recusado pelo dono. Declarado
  // fora do `if` para poder entrar na saída da missão nos dois ramos
  // (mesclado ou não) sem repetir a variável.
  let resultadoDoMerge: ResultadoDoMerge | null = null

  // Task 8: o parecer sobre uma entrega NÃO delegada carrega, em linguagem
  // de negócio, a mesma frase que existe para não repetir o quase-acidente
  // do PR #99 — o GitOrch opina, mas quem decide se mescla é a pessoa dona
  // do PR. Igual nos dois vereditos (aprovar ou pedir mudanças): a pessoa
  // que lê a review no GitHub precisa saber, sempre, que isto é uma opinião
  // e não um convite a clicar em "merge" esperando o produto terminar.
  const avisoDeNaoMesclar = delegado
    ? ''
    : `\n\n${MARCA_SEM_PODER_DE_MESCLAR}\n` +
      'GitOrch analisou este PR e registrou o parecer acima, mas NÃO vai mesclá-lo: esta ' +
      'entrega não foi encomendada pelo produto. A decisão de aceitar este código é sua, como ' +
      'autor do PR.'

  if (effectiveVerdict === 'approve') {
    // Caminho resiliente (o GitHub decide se pode aprovar) + o campo do padrão
    // Shrimp: o resumo do veredito é o Goal.
    await postarReview(
      reviewEvent,
      // O texto da aprovação usa a MARCA como pedaço do corpo, e não uma
      // cópia à mão de "verdict: APPROVE": é essa mesma marca que a leitura
      // de "já tem parecer" procura depois para distinguir aprovação de
      // reprovação. Enquanto eram duas cadeias iguais por coincidência,
      // mexer no texto aqui deixaria a leitura cega sem quebrar teste nenhum.
      `${JULES_MARKER}${marcaDoLegado}\nGitOrch QA ${MARCA_DE_APROVACAO} — criteria met, CI green.\n\n${verdict.comment.goal}${avisoDeNaoMesclar}`
    )

    // Task 8 ("julga todos, mescla só o que delegou"): o QUARTO porteiro,
    // antes dos três de sempre — sem prova de delegação, a missão nem tenta
    // mesclar. Uma entrega de humano aprovada pelo QA fica só com o parecer.
    if (delegado) {
      // Task 9: `shaAtual` tem de ser lido AGORA — nunca herdado de `pr`
      // (passo 2, minutos atrás, antes do motor rodar). Reusar `pr.head.sha`
      // aqui compararia o sha revisado contra ele mesmo e o portão não
      // provaria nada; só uma chamada NOVA ao GitHub, feita bem na porta do
      // merge, sabe se o dev empurrou algo depois da aprovação.
      const entregaAgora = (await gh(
        'GET',
        `/repos/${options.repository}/pulls/${target.number}`
      )) as { head?: { sha?: string } }

      // Os CINCO porteiros (delegado, sha revisado = sha atual, QA aprovou,
      // CI verde, diff completo) já foram satisfeitos para chegar aqui —
      // `mesclarPr` os reconfere de propósito: é o guarda final antes de
      // tocar no repositório do cliente, não uma confiança cega no que a
      // trava de cima já decidiu.
      //
      // Tarefa 10: só conta como "fracasso de mescla" (R3 do controlador)
      // quando o GitHub de fato foi CHAMADO e recusou — nunca quando um dos
      // cinco porteiros bloqueou antes disso (ex.: o sha mudou de novo nesta
      // fresta). Um porteiro nosso não é uma recusa do GitHub.
      let chamouOGithub = false
      // Gravado dentro do `merge()` abaixo, quando (e só quando) o GitHub de
      // fato aceita a mescla. É o sha do commit NOVO que o squash cria no
      // branch base — nunca `pr.head.sha` (aquele commit, da branch da
      // entrega, deixa de existir depois do squash). Sem este valor certo, a
      // Tarefa 13 (`acompanharPublicacao`) jamais encontraria a execução do
      // CD que publica ESTE commit — compararia contra um sha que nunca
      // aparece no branch que o CD observa.
      let mergeCommitSha = ''
      resultadoDoMerge = await mesclarPr({
        numeroDoPr: target.number,
        ciState,
        vereditoDoQa: effectiveVerdict,
        diffTruncado: truncado,
        delegado,
        shaRevisado: pr.head?.sha ?? '',
        shaAtual: entregaAgora.head?.sha ?? '',
        merge: async () => {
          // Nunca seguir URL devolvida pelo GitHub: a rota é montada aqui, a
          // partir do NÚMERO do PR e do repositório que já temos — nunca de um
          // campo `url`/`html_url` vindo da resposta de outra chamada.
          //
          // I2 (revisão final): `sha` amarra o merge ao HEAD que foi de fato
          // revisado — lido em `pr.head.sha` (passo 2, minutos antes de chegar
          // aqui: o motor demora). Sem isto, um push do dev nessa janela (e é
          // exatamente o que o QA pede ao reprovar: "Revise the SAME pull
          // request") faz o produto mesclar código que ninguém leu nem
          // verificou — furando os três porteiros por dentro. O GitHub recusa
          // com 409 se o head mudou desde então, e 409 já cai no caminho de
          // "merge recusado" (mesmo tratamento do C1), virando motivo
          // declarado em vez de mesclar às cegas.
          chamouOGithub = true
          const resposta = (await gh(
            'PUT',
            `/repos/${options.repository}/pulls/${target.number}/merge`,
            { merge_method: 'squash', sha: pr.head?.sha }
          )) as { sha?: string }
          mergeCommitSha = resposta.sha ?? ''
          return true
        },
      })
      if (resultadoDoMerge.mesclado) {
        if (options.aoMesclar) {
          await options.aoMesclar({
            numeroDoPr: target.number,
            mergeCommitSha,
            issueNumber: issueDaEntrega,
          })
        }

        // Leva B ("o quadro do cliente não pode dizer entregue antes da
        // hora"): este módulo NÃO fecha mais a tarefa nem move o card aqui.
        // O merge só prova que o CÓDIGO mudou de mãos — nada aqui sabe
        // ainda se aquilo chegou ao ar. Quem decide fechar a tarefa
        // (`fecharTarefaEntregue`, fechar-tarefa.ts) e mover o card para
        // "done" é `varrerPublicacoes` (scheduler.ts,
        // `resolverEntregaDoBoard`), no momento em que a vigília pós-merge
        // chega a um veredito sobre a publicação — positivo, ou repositório
        // provado sem mecanismo de publicação (aí o merge já É a entrega).
      } else if (chamouOGithub && linhaDaEntrega) {
        // Tarefa 10: o GitHub recusou de verdade (conflito, regra do
        // repositório, pedido inválido, ou a chamada falhou por rede — R3 do
        // controlador não distingue o motivo). Conta mais um fracasso contra
        // este commit: soma sobre o que já existia se esta passagem estava
        // RETOMANDO uma aprovação parada no MESMO head; recomeça do zero se é
        // a primeira vez que este commit específico é aprovado (commit novo,
        // tentativa nova — a zeragem da R3).
        const fracassosAnteriores = retomandoAprovacaoMesmoCommit ? linhaDaEntrega.mergeFailures : 0
        const fracassosAgora = fracassosAnteriores + 1
        if (options.registrarFracassoDeMerge) {
          await options.registrarFracassoDeMerge({
            sessionName: linhaDaEntrega.sessionName,
            contador: fracassosAgora,
            agora,
          })
        }
        // Bateu o teto: avisa o dono com o motivo REAL que o GitHub devolveu
        // e para de tentar — a próxima passagem vai encontrar
        // `mergeFailures >= MAX_TENTATIVAS_DE_MERGE` no laço de descoberta
        // (mais acima) e pular esta entrega até o commit mudar. Best-effort,
        // mesmo padrão dos outros avisos deste arquivo: falhar ao notificar
        // não pode derrubar a missão.
        if (fracassosAgora >= MAX_TENTATIVAS_DE_MERGE && options.avisarDono) {
          await options
            .avisarDono(
              `GitOrch: o merge do PR #${target.number} (${options.repository}) falhou ` +
                `${MAX_TENTATIVAS_DE_MERGE} vezes seguidas para o mesmo commit — ${resultadoDoMerge.motivo}. ` +
                'GitOrch parou de tentar mesclar este commit; é preciso ação humana (ex.: ' +
                'resolver o conflito) antes de uma nova tentativa.'
            )
            .catch(() => undefined)
        }
      }
    }
  } else {
    await postarReview(
      reviewEvent,
      `${JULES_MARKER}${marcaDoPortao}${marcaDoLegado}\nGitOrch QA verdict: REQUEST CHANGES (see comment).${explicacaoDoTamanho}${avisoDeNaoMesclar}`
    )

    // Este julgamento entra na conta do repositório ANTES de decidir se pede
    // retrabalho: a reprovação da vez faz parte da sequência que está sendo
    // medida. Best-effort — não conseguir guardar não pode impedir o parecer
    // de existir, que é o que o dev lê.
    // A aproximação conhecida: `julgadoComCiVermelho` é o motor reprovando com
    // o CI vermelho, e dali não se sabe se ele reprovou POR causa do CI ou se
    // achou um defeito de verdade no mesmo instante. Contar como portão é o
    // lado seguro para a ESCALADA (o dev tem o que fazer nos dois casos:
    // consertar o CI), mas estreitaria o caminho de volta se ele fosse só a
    // reprovação de código. Por isso o caminho de volta não depende só dela:
    // uma APROVAÇÃO também zera a conta, e ela é prova direta de que a esteira
    // consegue levar uma entrega deste projeto até o fim.
    const peloPortao = barradoPorTamanho || julgadoComCiVermelho || rebaixadoSoPeloCi
    if (options.registrarJulgamento) {
      await options
        .registrarJulgamento({ repositorio: options.repository, peloPortao })
        .catch(() => undefined)
    }

    // O projeto está com defeito próprio, ou foi só esta entrega? Dez
    // reprovações seguidas pelo mesmo obstáculo não são dez entregas ruins, e
    // redelegar de novo produz a mesma parada — só que sem ninguém saber.
    let projetoTravado = false
    if (options.lerHistoricoDoProjeto) {
      try {
        const historico = await options.lerHistoricoDoProjeto(options.repository)
        const decisao = decidirSobreOProjeto(historico, options.repository)
        if (decisao.acao === 'escalar') {
          // Travar o projeto só vale se o dono FICAR SABENDO. Sem aviso
          // entregue, o dev não é chamado, o commit não muda, o skip de "já
          // julgado" nunca reabre a entrega e ninguém percebe — mordaça
          // completa. Aviso que falha volta ao ciclo de sempre: repetir é ruim,
          // emudecer é pior.
          const avisado = options.avisarDono
            ? await options
                .avisarDono(`GitOrch: ${decisao.diagnostico}`)
                .then(() => true)
                .catch(() => false)
            : false
          projetoTravado = avisado
          if (!avisado) {
            options.onWarn?.(
              `[qa] ${options.repository} bateu o teto de barradas seguidas, mas o aviso ao ` +
                'dono não saiu — seguindo com o retrabalho para não emudecer a entrega'
            )
          }
        }
      } catch (err) {
        // Não conseguir ler o histórico é "não sei", e "não sei" NUNCA barra:
        // barrar por ignorância travaria um projeto saudável.
        options.onWarn?.(
          `[qa] não deu para ler o histórico de ${options.repository}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    // O comentário de rework menciona @jules e pede retrabalho NA MESMA PR —
    // só faz sentido para a entrega que o produto delegou. Uma entrega de
    // humano não tem dev assíncrono nenhum para retrabalhar; mencionar
    // @jules na PR de outra pessoa seria ruído, não ajuda.
    //
    // E não faz sentido nenhum quando o projeto está travado: pedir retrabalho
    // ali é mandar o dev consertar um obstáculo que não é dele. O dono já foi
    // avisado com o diagnóstico; o caminho de volta é uma entrega ser julgada
    // pelo conteúdo.
    if (delegado && !projetoTravado) {
      await gh('POST', `/repos/${options.repository}/issues/${target.number}/comments`, {
        body: buildJulesReworkComment(verdict.comment),
      })

      // Task 10 (decisão do dono 14/08/2026): "tem que ter lógica entre jules e
      // QA". O comentário acima morre no PR — o dev assíncrono não lê o PR
      // dele. Entrega a MESMA reprovação na sessão viva para ele retrabalhar.
      // Sem linha correspondente (PR de humano, ou anterior a esta mudança), a
      // missão segue sem avisar — não é falha.
      if (options.avisarSessao) {
        // `linhaDaEntrega` já foi resolvida mais acima (mesma ordem de
        // autoridade: PR primeiro, issue de origem como segunda tentativa) —
        // reaproveitada aqui, não recalculada.
        if (linhaDaEntrega) {
          const texto = [
            `GitOrch QA reviewed your pull request #${target.number} and it is NOT accepted yet.`,
            '',
            'What must change:',
            verdict.comment.implementationGuide,
            '',
            'Verification Criteria that are still not met:',
            verdict.comment.verificationCriteria,
            '',
            'Revise the SAME pull request. Do not open a new one, and do not change',
            'anything outside the scope described above.',
          ].join('\n')

          // Best-effort e BARULHENTO: falhar ao avisar não pode derrubar a
          // missão (o veredito já foi postado no PR), mas silenciar seria
          // repetir o defeito que esta mudança existe para matar — por isso o
          // aviso sai mesmo quando `avisarSessao` rejeita ou lança.
          const avisou = await options
            .avisarSessao({ sessionName: linhaDaEntrega.sessionName, texto })
            .catch(() => false)
          if (!avisou) {
            const avisar = options.onWarn ?? console.warn
            avisar(
              `[qa] veredito postado no PR #${target.number}, mas a sessão ` +
                `${linhaDaEntrega.sessionName} não foi avisada — guardando para reentregar`
            )
            // O recado fica GUARDADO, não só gritado. Medido em 21/08: um 429
            // passageiro encalhou a entrega em definitivo, porque o parecer já
            // estava postado e a passagem seguinte pula quem "já foi julgado".
            // O mesmo texto, reenviado minutos depois, foi aceito na hora.
            if (options.registrarAvisoPendente) {
              await options
                .registrarAvisoPendente({ sessionName: linhaDaEntrega.sessionName, texto })
                .catch((err) =>
                  avisar(
                    `[qa] não consegui nem guardar o pedido de retrabalho de ` +
                      `${linhaDaEntrega.sessionName}: ${(err as Error).message}`
                  )
                )
            }
          }
        }
      }
    }
  }

  // 4b) O QA acabou de julgar: marca a issue VINCULADA (não a PR) como sua,
  // tirando quem estava com ela antes (ex.: gitorch:agent:jules, o dev
  // assíncrono que abriu o PR). Best-effort: aplicarLabelDoAgente nunca lança
  // — o veredito já foi postado acima, isso é só sinalização.
  //
  // Achado B da revisão independente da Tarefa 8: `linkedIssue` sozinho NÃO é
  // prova de autoria — para uma entrega não-delegada ele vem do mesmo recuo
  // fraco (regex `closes|fixes|resolves #N` sobre o corpo da PR, sem sessão,
  // sem etiqueta) que a doutrina do dono batizou de "citação de texto não é
  // prova de entrega". Escrever no board do CLIENTE (label + card) por essa
  // única evidência é o mesmo quase-acidente original, agora mirando a
  // infraestrutura do cliente em vez do merge. Julgar e postar o parecer
  // continuam para QUALQUER entrega — só a ESCRITA no board fica atrás do
  // mesmo `delegado` que já trava o merge.
  if (delegado && linkedIssue) {
    await aplicarLabelDoAgente({
      repository: options.repository,
      issueNumber: Number(linkedIssue),
      agente: 'qa',
      lerLabels: async () => linkedIssueLabels,
      adicionarLabel: async (l) => {
        await gh('POST', `/repos/${options.repository}/issues/${linkedIssue}/labels`, {
          labels: [l],
        })
      },
      removerLabel: async (l) => {
        await gh(
          'DELETE',
          `/repos/${options.repository}/issues/${linkedIssue}/labels/${encodeURIComponent(l)}`
        )
      },
    })
  }

  // 5) Rework: o card volta para "inProgress" — sinaliza que a entrega
  // precisa de retrabalho, o que é verdade no INSTANTE do julgamento, sem
  // depender de publicação nenhuma. Best-effort: board sem coluna/campo
  // nunca derruba o julgamento já postado.
  //
  // Leva B: aprovação NÃO move mais o card para "done" aqui — só a
  // publicação confirmada (ou repositório provado sem mecanismo de
  // publicação) move, em `resolverEntregaDoBoard` (scheduler.ts). Antes
  // desta mudança o card ia para "done" no instante do JULGAMENTO,
  // independente até de o merge ter de fato acontecido (`resultadoDoMerge`
  // não era consultado aqui) — o quadro do cliente podia dizer "pronto" com
  // o merge bloqueado por conflito.
  //
  // Mesmo gate do Achado B acima: mover o card do cliente também é escrita em
  // infraestrutura do cliente para trabalho que ele não encomendou.
  let cardNote = ''
  if (delegado && options.moveCard && linkedIssue && effectiveVerdict !== 'approve') {
    try {
      const moved = await options.moveCard(Number(linkedIssue), 'inProgress')
      cardNote = ` ${moved}.`
    } catch (err) {
      cardNote = ` card move failed: ${String(err).slice(0, 120)}.`
    }
  }

  // A lacuna vira MEMÓRIA, não exceção de merge. Decisão do dono (14/08/2026):
  // repositório sem verificação automática é trabalho de backlog — o QA
  // registra, o RA monta os dados técnicos de como criar a verificação naquele
  // projeto, e o PO gera as tarefas. Tratar "sem verificação" como verde era
  // mesclar sem nenhuma rede, exatamente no repositório bagunçado que o produto
  // existe para arrumar.
  const lacunas: string[] = []
  if (ciState === 'no checks') {
    lacunas.push(
      'GITORCH-GAP: this repository has no automated checks. Judgment fell back to ' +
        'diff reading alone, with no test evidence. This is a CRITICAL gap: the ' +
        'repository needs a CI workflow before delivery can be trusted. RA: produce ' +
        'the technical grounding for adding it (which commands, which files, which ' +
        'trigger). PO: turn it into backlog.'
    )
  }
  if (truncado) {
    lacunas.push(
      `GITORCH-GAP: PR #${target.number} diff did not fit (${arquivos} files); ` +
        'judgment was made on a partial view and approval was blocked.'
    )
  }

  // `cardNote` já é efeito colateral registrado (a movimentação em si já
  // aconteceu acima) — preservado aqui como parte do resumo para não perder
  // informação que já existia na saída antes desta mudança.
  //
  // `resultadoDoMerge` só existe no ramo de aprovação (`null` em rework), e o
  // motivo — mesclado ou não — precisa aparecer aqui: uma falha do GitHub no
  // merge (PR com conflito, 405, etc.) não pode ficar muda dentro do try/catch
  // de `mesclarPr`. Ela vira texto na saída da missão, que `persistMissionMemory`
  // grava como memória do projeto — declarada, nunca engolida.
  const mergeNote = resultadoDoMerge
    ? ` Merge: ${resultadoDoMerge.mesclado ? 'merged' : 'blocked'} (${resultadoDoMerge.motivo}).`
    : ''
  const resumo = `QA judged PR #${target.number}: ${effectiveVerdict} (CI ${ciState}).${cardNote}${mergeNote}`
  return {
    exitCode: 0,
    output: [resumo, ...lacunas].join('\n'),
    stderr: '',
    // Task 8: espelha `delegado`, independente do veredito — a entrega foi
    // julgada de qualquer forma; só quem o produto encomendou pode mesclar.
    podeMesclar: delegado,
  }
}
