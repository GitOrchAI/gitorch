import { GithubExecutionError } from './github-backlog.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { aplicarLabelDoAgente } from './agent-label.js'
import { escolherParaDelegar, type IssueCandidata } from './fila-de-delegacao.js'
import { tarefasComEntregaMesclada } from './ambiente-declarado.js'
import type { LinhaDeSessao } from './dev-session-store.js'
import { fetchComTeto } from './fetch-com-teto.js'
import { acharParecerNesteHead, ehParecerSemPoderDeMesclar } from './parecer-do-qa.js'
import { arquivosDeclarados } from './secao-da-issue.js'
import { montarPedidoAoDev } from './pedido-ao-dev.js'
import { ehPrDelegado } from './pr-delegado.js'
import type { AchadoDeDiagnostico, IssueParaDiagnostico } from './diagnostico-de-issues.js'

// Delegação contínua do SM (F3.6 item 2): a cada wake, encontra as TASKS prontas
// (label `gitorch:task`, sem sessão viva na tabela `dev_sessions`, com todos os
// "Blocked by" já fechados) e aplica a label de delegação — assim uma task que
// desbloqueia no MEIO da sprint segue sozinha, sem esperar o próximo
// sprint-planning. É determinístico (o "julgamento" mecânico é código, não LLM
// — a Lei).
//
// A fila é decidida pela linha da sessão (fila-de-delegacao.ts), não pela
// etiqueta: a etiqueta é irreversível na prática (uma vez aplicada, nunca sai
// sozinha), e usá-la como critério de fila foi o que fez #46, #47 e #48
// morrerem em silêncio — delegadas, a sessão caiu, e como carregavam a
// etiqueta nunca voltaram a ser candidatas.

/**
 * A etiqueta com que o Scrum Master ENCONTRA trabalho para delegar.
 *
 * Exportada porque quem CRIA tarefa precisa usar exatamente esta — e uma cópia
 * escrita à mão do outro lado já custou um defeito: a tarefa nascia com a
 * etiqueta do agente sozinha, nunca aparecia nesta busca, e ficava órfã para
 * sempre no repositório do cliente.
 */
export const TASK_LABEL = 'gitorch:task'

/**
 * Quantas entregas o SM manda julgar por acordada.
 *
 * MESMO desenho (e mesmo número) do cap de delegação logo abaixo, e pelo
 * mesmo motivo: fluxo sustentável, não rajada. O teto de concorrência do
 * relógio já impede duas missões ao mesmo tempo, mas ele segura DEPOIS de a
 * missão ser pedida — sem um cap aqui, um repositório com trinta entregas
 * paradas encheria a fila do relógio de uma vez e empurraria todo o resto do
 * dia para trás.
 */
export const CAP_PADRAO_DE_JULGAMENTO = 3

/** Quantas entregas abertas o SM olha por acordada (mesma página do julgamento). */
const PRS_POR_PAGINA = 20

/**
 * As entregas abertas que AINDA NÃO TÊM parecer nosso no commit de agora.
 *
 * Por que isto existe: o julgamento só acordava por aviso do GitHub (CI
 * concluído, pull request aberto) ou pela vigília de uma sessão viva. Uma
 * entrega cuja verificação terminou dias atrás e cuja sessão já encerrou não
 * tem quem chame o QA — foi assim que o #97 ficou parado desde 15/08 com a
 * verificação verde. `docs/agents/quality-assurance.md` §3.1 já mandava que o
 * SM fosse o orquestrador do julgamento; o código é que não fazia.
 *
 * A leitura é a MESMA do laço de descoberta do julgamento
 * (`acharParecerNesteHead`, parecer-do-qa.ts) — de propósito, e não uma
 * segunda cópia da regra: o que o SM enfileira aqui é um subconjunto estrito
 * do que o julgamento aceita julgar, então nenhuma acordada pedida por este
 * caminho chega lá para descobrir que não tinha nada a fazer.
 *
 * Não decide NADA sobre mesclagem: quem pode ser mesclado continua sendo
 * decidido no ponto do merge, dentro do julgamento.
 *
 * ESTEIRA-T12: só entra PR que o julgamento de fato aceita julgar — aberto,
 * DELEGADO (`ehPrDelegado`) e sem parecer nosso neste head. Sem o filtro de
 * delegação, um PR do Dependabot ou de humano aparecia na fila e no log ("SM
 * queued #337, #338"), escondendo o estado real: o QA acorda, vê que não é
 * entrega do produto e devolve vazio. `sessoes` ausente = comportamento antigo
 * (sem filtro) — só o scheduler passa a lista.
 */
export async function listarPrsSemParecer(args: {
  repository: string
  gh: (method: string, path: string) => Promise<unknown>
  cap: number
  /**
   * Linhas de sessão deste projeto (vivas e recém-fechadas) que carregam um
   * `pullRequestNumber` — a prova de que o PR é trabalho delegado. Ausente:
   * nenhum filtro de delegação (compatível com quem chamava antes do T12).
   */
  sessoes?: LinhaDeSessao[]
}): Promise<number[]> {
  if (args.cap <= 0) return []

  const prs = (await args.gh(
    'GET',
    `/repos/${args.repository}/pulls?state=open&sort=created&direction=desc&per_page=${PRS_POR_PAGINA}`
  )) as Array<{
    number: number
    draft?: boolean
    head?: { sha?: string }
    user?: { login?: string }
    body?: string
  }>

  const semParecer: number[] = []
  for (const p of Array.isArray(prs) ? prs : []) {
    // Rascunho não é entrega — o julgamento também o pula.
    if (p.draft) continue
    // ESTEIRA-T12: PR que não é trabalho delegado (Dependabot, humano) não é
    // julgado — não polui a fila nem o log. O recuo por etiqueta na issue
    // (`ehPrDelegado` #3) fica de fora aqui: o SM não carrega labels por issue
    // neste ponto, e o PR real do dev já casa pela linha da sessão (#1).
    if (args.sessoes) {
      const { delegado } = ehPrDelegado({
        numeroDoPr: p.number,
        autor: p.user?.login,
        corpo: p.body,
        sessoes: args.sessoes,
        issueComEtiquetaDeDelegacao: () => false,
      })
      if (!delegado) continue
    }
    // O cap corta ANTES da leitura das reviews: uma entrega que não caberia
    // nesta acordada não vale uma chamada à API do GitHub.
    if (semParecer.length >= args.cap) break

    const reviews = (await args.gh(
      'GET',
      `/repos/${args.repository}/pulls/${p.number}/reviews?per_page=100`
    )) as Array<{ body?: string; commit_id?: string }>

    // Um parecer marcado neste head normalmente significa "já julgado" — e a
    // entrega sai da fila. A EXCEÇÃO é o parecer emitido por quem, naquele
    // instante, não sabia que a entrega era do produto: esse foi escrito sob
    // premissa errada e o julgamento agora o refaz (ver a exceção da premissa
    // errada em qa-rails-mission.ts).
    //
    // Sem esta linha, esta fila deixaria de ser o que o comentário do topo
    // deste arquivo promete: um subconjunto estrito do que o julgamento
    // aceita julgar. Na prática o conserto só dispararia pelo relógio próprio
    // do QA, e a entrega presa dependeria de o laço chegar nela antes de
    // parar num pull request mais novo.
    const parecer = acharParecerNesteHead(reviews, p.head?.sha)
    if (parecer && !ehParecerSemPoderDeMesclar(parecer)) continue
    semParecer.push(p.number)
  }
  return semParecer
}

/** Marcador oculto que impede o comentário de recusa de se repetir. */
export const MARCA_DE_RECUSA = '<!-- gitorch:delegacao-recusada -->'

/**
 * Traduz a recusa do dev para uma frase que pode ser publicada.
 *
 * O motivo cru é útil e NÃO é publicável: são até duzentos caracteres do corpo
 * de erro do fornecedor, ou a mensagem de uma exceção de rede, e qualquer um
 * dos dois pode carregar host interno, endereço de IP ou trecho de payload.
 * Esse texto ia parar num comentário no repositório do CLIENTE, que muitas
 * vezes é público. O cru continua indo para o log estruturado, onde já ia.
 *
 * A tradução também é melhor para quem lê: "limite de sessões simultâneas
 * atingido" diz o que fazer; `FAILED_PRECONDITION` não diz nada a ninguém.
 */
export function motivoPublicavel(motivo: string): string {
  const m = motivo.toUpperCase()
  if (m.includes('FAILED_PRECONDITION') || m.includes('RESOURCE_EXHAUSTED')) {
    return 'o dev está com todas as sessões de trabalho ocupadas no momento'
  }
  if (m.includes('HTTP 404') || m.includes('NÃO ESTÁ CONECTADO')) {
    return 'o repositório não está conectado na conta do dev'
  }
  if (m.includes('HTTP 401') || m.includes('HTTP 403')) {
    return 'a credencial do dev foi recusada'
  }
  if (m.includes('HTTP 429')) {
    return 'o dev está recusando pedidos por excesso de chamadas'
  }
  return 'o serviço do dev recusou abrir a sessão de trabalho'
}

/**
 * O que o acionamento do dev assíncrono devolve.
 *
 * Os três casos precisam ser DISTINTOS, e essa é a lição de 21/08/2026:
 * enquanto "não configurado" e "recusou" voltavam os dois como `null`, o
 * chamador não tinha como saber se devia seguir com o plano B (a etiqueta) ou
 * dar meia-volta. Ele seguia sempre — e marcava como delegada uma tarefa que
 * o dev tinha acabado de recusar.
 *
 * - `criada`: a sessão existe lá fora e tem identificador.
 * - `desligado`: recurso não configurado. NÃO é erro; a etiqueta é o plano B.
 * - `falhou`: o dev foi chamado e recusou. A issue não pode parecer delegada.
 */
export type ResultadoDoAcionamentoDoDev =
  | { situacao: 'criada'; sessionName: string }
  | { situacao: 'desligado' }
  | { situacao: 'falhou'; motivo: string }

export interface SmDelegationOptions {
  repository: string
  githubToken: string
  /** Label de delegação (padrão 'jules'). */
  delegateLabel?: string
  /** Máximo de delegações por ciclo (fluxo sustentável; padrão 3). */
  cap?: number
  /**
   * Máximo de julgamentos pedidos por ciclo. Padrão: o mesmo cap da
   * delegação — o SM não abre a torneira de um lado mais do que do outro.
   */
  capJulgamento?: number
  /**
   * Põe na fila do julgamento as entregas abertas que ainda não têm parecer
   * nosso no commit de agora.
   *
   * Recebe os NÚMEROS só para o registro honesto no log: quem escolhe o que
   * julgar continua sendo o próprio julgamento, que refaz a descoberta ao
   * acordar. O que o SM faz aqui é garantir que alguém o acorde — sem isso,
   * uma entrega sem sessão viva e sem CI rodando não tem quem a chame.
   *
   * Ausente: o SM segue só delegando, exatamente como antes.
   */
  pedirJulgamento?: (prsSemParecer: number[]) => Promise<void> | void
  /**
   * Aciona o dev assíncrono de verdade e devolve o identificador da sessão.
   *
   * Sem isto, delegar era só pendurar o label e esperar que alguém do outro
   * lado percebesse — se ninguém estivesse escutando, a esteira morria em
   * silêncio. Devolver `null` é aceitável (recurso desligado, repositório não
   * conectado, serviço fora): o label continua valendo como plano B.
   */
  criarSessaoDev?: (args: {
    repository: string
    titulo: string
    prompt: string
  }) => Promise<ResultadoDoAcionamentoDoDev>
  /**
   * Guarda a ligação entre a issue e a sessão que acabou de nascer.
   *
   * Existe porque essa ligação vivia só no texto de saída desta missão e
   * evaporava com o log. Sem ela o PR entregue não é reconhecido para
   * julgamento: ele chega com o autor da conta da instalação e sem palavra de
   * ligação no corpo, então nenhum sinal lido do GitHub sozinho o identifica
   * como trabalho delegado.
   */
  aoCriarSessao?: (dados: { issueNumber: number; sessionName: string }) => Promise<void>
  /**
   * Reserva o lugar da issue ANTES de acionar o dev externo. Devolve `false`
   * quando outro já reservou.
   *
   * Existe porque a ordem inversa QUEIMAVA COTA. Medido em 24 horas: 39 das
   * 100 sessões diárias do plano nasceram no dev externo e foram desfeitas em
   * seguida, porque o banco recusava a ligação com "já existe sessão viva para
   * a issue". Desfazer devolve a vaga, mas NÃO devolve a cota — a sessão
   * contou no teto de 24 horas do mesmo jeito, sem uma linha de trabalho ter
   * saído dela.
   *
   * Com a reserva antes, a issue já delegada nem chega a virar chamada ao dev.
   */
  reservarLugarDaIssue?: (issueNumber: number) => Promise<boolean>
  /** Devolve a reserva quando o dev externo recusa criar a sessão. */
  liberarLugarDaIssue?: (issueNumber: number) => Promise<void>
  fetchImpl?: typeof fetch
  /**
   * Linhas de sessão abertas deste projeto. É a fila real: issue com linha viva
   * já está sendo trabalhada; issue sem linha viva está por delegar, mesmo que
   * já tenha sido delegada antes e a sessão tenha morrido.
   */
  sessoesVivas?: LinhaDeSessao[]
  /**
   * ESTEIRA-T12: linhas deste projeto (vivas e recém-fechadas) que carregam um
   * `pullRequestNumber` — usadas para reconhecer quais PRs abertos são trabalho
   * delegado antes de mandá-los para o julgamento. Ausente: o SM cai em
   * `sessoesVivas`; ausentes as duas, nenhum filtro (comportamento pré-T12).
   */
  sessoesParaReconhecerPr?: LinhaDeSessao[]
  /**
   * TODAS as linhas deste projeto, vivas e fechadas — é entre elas que mora a
   * prova de que uma tarefa já foi entregue. `sessoesVivas` não serve: a linha
   * de uma entrega mesclada pode já ter sido fechada.
   */
  entregasDoProjeto?: Array<{ issueNumber: number; mergeCommitSha?: string | null }>
  /** Sessões abertas neste projeto nas últimas 24h, para o teto diário. */
  delegadasHoje?: number
  /** Linhas abertas na CONTA inteira — só para diagnóstico/log. */
  vivasNaConta?: number
  /**
   * Sessões da CONTA inteira que OCUPAM uma vaga simultânea AGORA (só os
   * estados que o Jules ainda está tocando). É o número certo para o teto de
   * concorrência: uma linha aberta em COMPLETED/FAILED já liberou a vaga lá.
   */
  ocupamVagaNaConta?: number
  /** Issues que falharam 2× e esperam a análise antes da 3ª tentativa (D51). */
  issuesComAnalisePendente?: number[]
  /** issueNumber → pedido revisado da análise, para o prompt da 3ª tentativa. */
  aprendizadoPorIssue?: Map<number, string>
  /**
   * ESTEIRA-T9: issues de incidente de infra que JÁ têm um PR aberto cobrindo
   * a causa (`infra_incidents.pr_number`). Um incidente = uma issue = UM PR:
   * o SM não delega uma segunda sessão para o mesmo bug. issueNumber → prNumber.
   */
  issuesComPrDeIncidente?: Map<number, number>
  /**
   * Comenta na issue "coberto por #PR" — UMA vez. Best-effort; o próprio
   * callback é responsável pela idempotência (marcador no comentário).
   */
  comentarCoberturaDeIncidente?: (args: { issueNumber: number; prNumber: number }) => Promise<void>
  /**
   * ESTEIRA-T10: issues de incidente ESCALADO (`infra_incidents.escalated_at`)
   * — 3 PRs fracassaram, o GitOrch parou de insistir. Não delega mais até o RA
   * fazer o retro. Silencioso (a escalada já avisou o dono).
   */
  issuesDeIncidenteEscalado?: number[]
  /** Do plano declarado pelo dono. Padrão: Free, que é o mais restritivo. */
  tetoConcorrentes?: number
  tetoDiario?: number
  /**
   * Canal do aviso de degradação — antes hardcoded em `console.warn`,
   * invisível na observabilidade estruturada. Produção (scheduler.ts) sempre
   * passa `app.log.warn`. Default: console.warn (só pra chamadas fora do
   * plugin).
   *
   * Não é preciosismo: este é justamente o aviso que existe para o
   * julgamento não morrer em silêncio quando a sessão nasceu no dev
   * assíncrono mas a ligação issue↔sessão não pôde ser guardada — sem essa
   * ligação, o QA não reconhece o PR que chegar depois. Mesmo motivo já
   * registrado em `github-app-token.ts` e `qa-rails-mission.ts`.
   */
  /**
   * Fala com o dono quando a delegação é RECUSADA pelo dev.
   *
   * O log estruturado não basta aqui: a falha deixa uma tarefa parada na fila
   * sem ninguém trabalhando nela, e isso é notícia de negócio, não de
   * infraestrutura. Best-effort — um notificador fora do ar nunca derruba o
   * ciclo.
   */
  /**
   * Encerra no fornecedor uma sessão que nasceu mas não pôde ser registrada
   * aqui. Sem isto, cada falha de gravação vira uma vaga presa para sempre —
   * exatamente o vazamento que a outra metade desta mudança veio estancar.
   */
  desfazerSessao?: (sessionName: string) => Promise<void>
  avisarDono?: (mensagem: string) => Promise<void>
  onWarn?: (message: string) => void
  /**
   * O CONSERTO DE MAIOR VALOR (D14, 01/09): roda o diagnóstico "já resolvido"
   * (services/diagnostico-de-issues.ts, PR #437) nas candidatas ANTES de
   * delegar — não só quando o repositório é "ligado" pelo painel, que era
   * onde ele já existia e nunca evitava a delegação em si.
   *
   * Caso real que motivou: a issue #46 de GitOrchAI/gitorch pedia registrar
   * o /wishlist, o commit d175cb70 já tinha implementado (17 dias antes), e
   * mesmo assim a tarefa foi delegada — o dev gastou uma sessão inteira para
   * descobrir que o trabalho já estava pronto, e ainda acordou o dono com
   * uma pergunta que não era dele.
   *
   * Recebe só as issues que SERIAM delegadas neste ciclo (depois de todos os
   * outros filtros mais baratos) — nunca a lista inteira, para não gastar
   * grafo em issue que já ia ficar de fora por outro motivo. Devolve um mapa
   * issueNumber → achado, só para as que o diagnóstico marcou 'ja_resolvido'.
   *
   * O diagnóstico tem 43% de erro medido (o autor conferiu à mão) — por
   * isso ele nunca fecha nada sozinho aqui: `runSmDelegation` só SUSPENDE a
   * delegação e chama `sinalizarPossivelmenteResolvida`, que existe para
   * pedir revisão humana/RA, nunca para fechar a issue.
   *
   * Ausente: comportamento antigo, sem gate nenhum (compatibilidade com quem
   * já chama `runSmDelegation` sem esta capacidade).
   */
  diagnosticarJaResolvido?: (
    issues: IssueParaDiagnostico[]
  ) => Promise<Map<number, AchadoDeDiagnostico>>
  /**
   * Chamado no lugar de delegar, para cada issue que o diagnóstico marcou
   * 'ja_resolvido'. NÃO fecha a issue (o diagnóstico sugere, nunca fecha
   * sozinho — 43% de erro medido): o desenho aqui é "a tarefa vai para
   * revisão em vez de execução" — sinaliza (ex.: comentário na issue) para
   * quem decide (RA/humano) confirmar antes de fechar ou delegar mesmo
   * assim. Best-effort: uma falha aqui não pode travar o resto do ciclo.
   */
  sinalizarPossivelmenteResolvida?: (args: {
    issueNumber: number
    achado: AchadoDeDiagnostico
  }) => Promise<void>
}

export interface SmDelegationResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  delegated: number[]
  /** Entregas abertas sem parecer nosso que este ciclo mandou julgar. */
  paraJulgar: number[]
  /**
   * ESTEIRA-T11: a esteira voltou vazia ESPECIFICAMENTE por falta de vaga de
   * concorrência no dev externo — há trabalho pronto, folga diária, mas a
   * conta está lotada de sessões vivas. O scheduler mede quanto tempo isso
   * persiste e avisa o dono uma vez.
   */
  travadaPorVaga: boolean
  /**
   * D14: issues que o diagnóstico marcou 'ja_resolvido' e que por isso NÃO
   * foram delegadas neste ciclo — sinalizadas para revisão em vez de
   * viraram sessão. Vazio quando `diagnosticarJaResolvido` não foi passado.
   */
  sinalizadasComoResolvidas: number[]
}

/** Extrai os números de "Blocked by #N, #M" do corpo da issue. */
export function extractBlockers(body: string): number[] {
  const line = body.match(/Blocked by\s+([#\d,\s]+)/i)?.[1]
  if (!line) return []
  return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
}

export async function runSmDelegation(options: SmDelegationOptions): Promise<SmDelegationResult> {
  // IMPORTANTE (leva D): alcançável pelo tique (scheduler.ts, wake do SM)
  // sob `tickEmAndamento` — mesma classe de defeito do Crítico.
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = fetchComTeto(options.fetchImpl ?? fetchSemPermissao())
  const label = options.delegateLabel ?? 'jules'
  const cap = options.cap ?? 3

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
    if (!resp.ok) throw new GithubExecutionError(`GitHub ${method} ${path} failed (${resp.status})`)
    return resp.json().catch(() => ({}))
  }

  // Candidatas na ordem que o GitHub devolveu (a ordem da sprint).
  const tasks = (await gh(
    'GET',
    `/repos/${options.repository}/issues?state=open&labels=${encodeURIComponent(TASK_LABEL)}&per_page=100`
  )) as Array<{
    number: number
    title?: string
    labels: Array<{ name: string }>
    body?: string
    created_at?: string
    updated_at?: string
  }>
  const abertas = Array.isArray(tasks) ? tasks : []

  // Bloqueadores só para quem ainda não tem sessão viva — não adianta gastar
  // chamada em issue que já está em trabalho.
  const comSessaoViva = new Set((options.sessoesVivas ?? []).map((s) => s.issueNumber))
  // Tarefa cuja entrega JÁ FOI MESCLADA não vira sessão nova, mesmo que a
  // issue continue aberta no GitHub.
  //
  // A issue só fecha quando a publicação confirma. Quando essa confirmação
  // emperra — e emperrou: 992 leituras recusadas em 24h por um ambiente que o
  // aplicativo não pode ler —, a issue fica aberta com a etiqueta de tarefa e
  // volta para cá como se nada tivesse sido feito. Foi assim que a #110 ganhou
  // DOIS pull requests mesclados.
  //
  // Isto NÃO substitui o fechamento da tarefa: o quadro do cliente continua
  // tendo que ficar limpo. Isto impede o GASTO de refazer o que já está pronto.
  const jaEntregues = tarefasComEntregaMesclada(options.entregasDoProjeto ?? [])
  // ESTEIRA-T9: issue de incidente que já tem um PR aberto cobrindo a causa não
  // vira sessão nova — um incidente = uma issue = UM PR. Comenta uma vez.
  const comPrDeIncidente = options.issuesComPrDeIncidente ?? new Map<number, number>()
  // ESTEIRA-T10: incidente escalado (3 PRs sem resolver) não é redelegado.
  const escaladas = new Set(options.issuesDeIncidenteEscalado ?? [])

  // D14 — O CONSERTO DE MAIOR VALOR: roda "já resolvido" nas issues que
  // SOBREVIVERAM aos filtros mais baratos de cima (mesclada/incidente
  // coberto/incidente escalado/sessão viva) — nunca no lote inteiro, para não
  // gastar grafo em issue que já ia ficar de fora por outro motivo mais
  // barato de checar.
  const elegiveisParaDiagnostico = abertas.filter(
    (t) =>
      !jaEntregues.has(t.number) &&
      !escaladas.has(t.number) &&
      !comPrDeIncidente.has(t.number) &&
      !comSessaoViva.has(t.number)
  )
  const achadosJaResolvido =
    options.diagnosticarJaResolvido && elegiveisParaDiagnostico.length > 0
      ? await options.diagnosticarJaResolvido(
          elegiveisParaDiagnostico.map((t) => ({
            number: t.number,
            title: t.title ?? '',
            body: t.body ?? null,
            createdAt: t.created_at ?? new Date(0).toISOString(),
            updatedAt: t.updated_at ?? new Date(0).toISOString(),
            labels: t.labels.map((l) => l.name),
          }))
        )
      : new Map<number, AchadoDeDiagnostico>()
  const sinalizadasComoResolvidas: number[] = []

  const candidatas: IssueCandidata[] = []
  // Os arquivos de quem JÁ está em trabalho. Quem tem sessão viva é filtrado
  // das candidatas na linha seguinte, então sem esta coleta os arquivos dele
  // sumiriam da reserva e uma tarefa nova poderia ser delegada para o mesmo
  // arquivo — o conflito fabricado outra vez, agora entre dois ciclos.
  const arquivosEmTrabalho = new Set<string>()
  for (const t of abertas) {
    // Entrega mesclada sai da lista ANTES de qualquer outra conta: não gasta
    // chamada de bloqueador, não reserva arquivo, não ocupa vaga.
    if (jaEntregues.has(t.number)) continue
    // Incidente escalado: o GitOrch parou de insistir. Sai da fila em silêncio.
    if (escaladas.has(t.number)) continue
    // Incidente de infra já coberto por um PR aberto: não delega de novo.
    const prDoIncidente = comPrDeIncidente.get(t.number)
    if (prDoIncidente !== undefined) {
      if (options.comentarCoberturaDeIncidente) {
        await options
          .comentarCoberturaDeIncidente({ issueNumber: t.number, prNumber: prDoIncidente })
          .catch((err) =>
            (options.onWarn ?? console.warn)(
              `sm-delegation: comentário de cobertura da #${t.number} falhou: ${String(err).slice(0, 120)}`
            )
          )
      }
      continue
    }
    if (comSessaoViva.has(t.number)) {
      for (const arquivo of arquivosDeclarados(t.body)) arquivosEmTrabalho.add(arquivo)
      continue
    }
    // D14: o diagnóstico marcou esta issue como 'ja_resolvido'. NÃO delega —
    // o diagnóstico SUGERE (43% de erro medido), nunca fecha sozinho, então
    // a tarefa vai para revisão (sinalizada) em vez de virar sessão nova. É
    // exatamente o gasto que o caso real (#46 de GitOrchAI/gitorch, 17 dias
    // obsoleta) evidenciou: uma sessão inteira do dev para descobrir o óbvio.
    const achadoJaResolvido = achadosJaResolvido.get(t.number)
    if (achadoJaResolvido) {
      sinalizadasComoResolvidas.push(t.number)
      if (options.sinalizarPossivelmenteResolvida) {
        await options
          .sinalizarPossivelmenteResolvida({ issueNumber: t.number, achado: achadoJaResolvido })
          .catch((err) =>
            (options.onWarn ?? console.warn)(
              `sm-delegation: sinalizar #${t.number} como possivelmente resolvida falhou: ${String(err).slice(0, 120)}`
            )
          )
      }
      continue
    }
    let abertosCount = 0
    for (const b of extractBlockers(t.body ?? '')) {
      const blocker = (await gh('GET', `/repos/${options.repository}/issues/${b}`)) as {
        state?: string
      }
      if (blocker.state !== 'closed') abertosCount += 1
    }
    // Os arquivos vêm do MESMO corpo que já está em mãos (`t.body`, do
    // `GET /issues` acima) — nenhuma chamada extra ao GitHub. É a seção
    // "Related Files" que o PO preenche com caminhos reais do repositório.
    candidatas.push({
      number: t.number,
      bloqueadoresAbertos: abertosCount,
      arquivos: arquivosDeclarados(t.body),
    })
  }

  let travadaPorVaga = false
  const escolhidas = escolherParaDelegar({
    candidatas,
    arquivosEmTrabalho: [...arquivosEmTrabalho],
    sessoesVivas: options.sessoesVivas ?? [],
    delegadasHoje: options.delegadasHoje ?? 0,
    onDiagnostico: (d) => {
      travadaPorVaga = d.travadaPorVaga
    },
    // O teto de simultâneas é da CONTA e só conta quem ainda ocupa vaga no
    // Jules. Sem este número o cálculo caía no `sessoesVivas.length` DESTE
    // projeto — e 15 linhas COMPLETED abertas no gitorch zeravam a folga e
    // paravam a delegação (medido 29/08).
    ...(options.ocupamVagaNaConta !== undefined
      ? { ocupamVagaNaConta: options.ocupamVagaNaConta }
      : {}),
    ...(options.vivasNaConta !== undefined ? { vivasNaConta: options.vivasNaConta } : {}),
    ...(options.issuesComAnalisePendente
      ? { issuesComAnalisePendente: options.issuesComAnalisePendente }
      : {}),
    tetoConcorrentes: options.tetoConcorrentes ?? 3,
    tetoDiario: options.tetoDiario ?? 15,
    capPorCiclo: cap,
  })
  const porNumero = new Map(abertas.map((t) => [t.number, t]))

  const delegated: number[] = []
  // Identificadores das sessões abertas no dev assíncrono, para o watchdog cobrar.
  const sessoes: string[] = []
  // Quem foi escolhida, tentada e recusada pelo dev — com o motivo.
  const recusadas: Array<{ numero: number; motivo: string }> = []

  for (const numero of escolhidas) {
    const task = porNumero.get(numero)
    if (!task) continue

    // ACIONAR PRIMEIRO, PROMETER DEPOIS.
    //
    // Até 21/08/2026 a ordem era a inversa: a etiqueta ia para a issue e só
    // então o dev era acionado. Quando o acionamento falhava — e falhou onze
    // vezes num único dia, com as vagas do fornecedor esgotadas —, a issue
    // ficava marcada como delegada e nada acontecia. O quadro mostrava uma
    // tarefa em andamento que nunca começou, e nenhum sinal dizia o contrário.
    //
    // Marcar antes é prometer em nome de alguém que ainda não respondeu.
    // RESERVA ANTES DE GASTAR. A ordem importa e custou caro: acionar o dev
    // primeiro e descobrir depois que a issue já tinha dono queimou 39 das 100
    // sessões diárias em 24 horas. Desfazer a sessão devolve a vaga, mas a
    // cota do dia já foi consumida — ela conta no instante em que a sessão
    // nasce, não quando ela morre.
    if (options.reservarLugarDaIssue) {
      const ganhou = await options.reservarLugarDaIssue(task.number)
      if (!ganhou) {
        // Outro ciclo (ou outra instância) já pegou esta issue. Não é falha:
        // é a reserva funcionando. Sair aqui não gasta nada.
        continue
      }
    }

    let resultado: ResultadoDoAcionamentoDoDev = options.criarSessaoDev
      ? await options.criarSessaoDev({
          repository: options.repository,
          titulo: `#${task.number} ${task.title ?? ''}`.trim(),
          // O texto do pedido mora em `pedido-ao-dev.ts`, testado sozinho.
          // Ele era montado aqui à mão e não repetia os passos do guia, não
          // pedia conferência antes de abrir a entrega, e não dizia o que
          // fazer ao travar — foi assim que o #157 entregou três dos quatro
          // passos e depois ficou 44 horas em silêncio.
          prompt: montarPedidoAoDev({
            numero: task.number,
            repositorio: options.repository,
            titulo: task.title ?? '',
            corpo: task.body ?? '',
            // D51: se esta issue já falhou 2× e a análise entendeu o porquê, o
            // pedido revisado entra no TOPO do prompt — o agente lê primeiro.
            ...(() => {
              const rev = options.aprendizadoPorIssue?.get(task.number)
              return rev ? { aprendizado: rev } : {}
            })(),
          }),
        })
      : ({ situacao: 'desligado' } as const)

    // A LIGAÇÃO É GRAVADA ANTES DA ETIQUETA — e antes de qualquer outra coisa
    // que possa falhar.
    //
    // Enquanto a etiqueta vinha primeiro, uma recusa do GitHub (403, 422, cota)
    // derrubava a função INTEIRA com a sessão já viva lá fora e nenhuma linha
    // aqui. Dez minutos depois a reconciliação de vagas encontrava exatamente
    // isso — sessão ativa sem dono — e arquivava um trabalho que tinha acabado
    // de começar. O conserto de uma frente estava armando a outra.
    //
    // Se a gravação falhar, a sessão é DESFEITA na hora: criamos a conversa,
    // não conseguimos acompanhá-la, e deixá-la de pé só transformaria a
    // delegação perdida numa vaga vazada.
    if (resultado.situacao === 'criada' && options.aoCriarSessao) {
      try {
        await options.aoCriarSessao({
          issueNumber: task.number,
          sessionName: resultado.sessionName,
        })
      } catch (err) {
        const avisar = options.onWarn ?? console.warn
        avisar(
          `[sm] sessão ${resultado.sessionName} criada para #${task.number} mas a ligação não ` +
            `pôde ser guardada: ${(err as Error).message}`
        )
        if (options.desfazerSessao) {
          try {
            await options.desfazerSessao(resultado.sessionName)
          } catch (erroAoDesfazer) {
            avisar(
              `[sm] a sessão ${resultado.sessionName} ficou de pé sem dono e não pôde ser ` +
                `desfeita: ${(erroAoDesfazer as Error).message}`
            )
          }
        }
        resultado = {
          situacao: 'falhou',
          motivo: `a ligação com a sessão não pôde ser guardada: ${(err as Error).message}`,
        }
      }
    }

    if (resultado.situacao === 'falhou') {
      // O dev externo recusou depois de a reserva ter sido ganha: devolver o
      // lugar é obrigatório, senão a issue fica presa para sempre num dono que
      // não existe.
      if (options.liberarLugarDaIssue) {
        await options.liberarLugarDaIssue(task.number).catch(() => undefined)
      }
      recusadas.push({ numero: task.number, motivo: resultado.motivo })
      const avisar = options.onWarn ?? console.warn
      // O motivo cru vai para o log, e SÓ para o log. Ver `motivoPublicavel`.
      avisar(`[sm] delegação de #${task.number} recusada pelo dev: ${resultado.motivo}`)

      // UM comentário por issue, nunca um por ciclo.
      //
      // A issue recusada continua na fila e é reescolhida a cada acordada do
      // SM — a fila lê linhas de sessão, não etiquetas. Sem esta guarda, uma
      // indisponibilidade de dois dias empilharia dezenas de comentários
      // idênticos no repositório do cliente. Spam apaga sinal tanto quanto
      // silêncio, e é a mesma disciplina que a vigília já aplica aos avisos
      // de sessão parada.
      //
      // O marcador é oculto no HTML: quem lê a issue vê só o recado.
      let comentouAgora = false
      try {
        const anteriores = (await gh(
          'GET',
          `/repos/${options.repository}/issues/${task.number}/comments?per_page=100`
        )) as Array<{ body?: string }>
        const jaAvisado =
          Array.isArray(anteriores) &&
          anteriores.some((c) => (c.body ?? '').includes(MARCA_DE_RECUSA))

        if (!jaAvisado) {
          await gh('POST', `/repos/${options.repository}/issues/${task.number}/comments`, {
            body:
              `${MARCA_DE_RECUSA}\n` +
              `**Delegação não aconteceu.** O dev não abriu a sessão de trabalho para esta ` +
              `tarefa, então ela continua por fazer — sem etiqueta de delegada, de propósito, ` +
              `para o quadro não dizer que há alguém trabalhando nela.\n\n` +
              `Motivo: ${motivoPublicavel(resultado.motivo)}.\n\n` +
              `A esteira tenta de novo sozinha nos próximos ciclos.`,
          })
          comentouAgora = true
        }
      } catch (err) {
        avisar(
          `[sm] a delegação de #${task.number} falhou e o motivo não pôde ser escrito na ` +
            `issue: ${(err as Error).message}`
        )
      }

      // O dono é avisado NA MESMA CADÊNCIA do comentário — uma vez por issue.
      // Um recado por ciclo transformaria o Telegram dele em ruído, e ruído é
      // como o aviso importante seguinte passa despercebido.
      if (options.avisarDono && comentouAgora) {
        try {
          await options.avisarDono(
            `GitOrch: não consegui passar a tarefa #${task.number} de ${options.repository} para ` +
              `o dev, então ela continua na fila sem ninguém trabalhando nela. ` +
              `Motivo: ${motivoPublicavel(resultado.motivo)}.`
          )
        } catch (err) {
          avisar(`[sm] aviso ao dono não chegou: ${(err as Error).message}`)
        }
      }
      continue
    }

    await gh('POST', `/repos/${options.repository}/issues/${task.number}/labels`, {
      labels: [label],
    })

    // A bola passa do PO/RA para o dev assíncrono: marca a issue como sua e
    // tira quem estava com ela antes. Best-effort: aplicarLabelDoAgente nunca
    // lança — a delegação em si já aconteceu acima.
    await aplicarLabelDoAgente({
      repository: options.repository,
      issueNumber: task.number,
      agente: 'jules',
      lerLabels: async () => task.labels.map((l) => l.name),
      adicionarLabel: async (l) => {
        await gh('POST', `/repos/${options.repository}/issues/${task.number}/labels`, {
          labels: [l],
        })
      },
      removerLabel: async (l) => {
        await gh(
          'DELETE',
          `/repos/${options.repository}/issues/${task.number}/labels/${encodeURIComponent(l)}`
        )
      },
    })

    delegated.push(task.number)

    if (resultado.situacao === 'criada') {
      sessoes.push(`#${task.number}→${resultado.sessionName}`)
    }
  }

  // O SM é o orquestrador do julgamento (docs/agents/quality-assurance.md
  // §3.1), não só o delegador. Roda DEPOIS da delegação de propósito: se o
  // GitHub falhar aqui, as delegações que já aconteceram acima não podem ser
  // perdidas junto.
  //
  // A falha é isolada e DITA — no aviso estruturado e na saída da missão —
  // pelo mesmo motivo do sensor de incidentes (scheduler.ts): quem lê o
  // resultado desta acordada precisa saber que a fila do julgamento não foi
  // levantada, em vez de ler "nada a julgar" e acreditar.
  let paraJulgar: number[] = []
  let falhaAoEnfileirar = ''
  if (options.pedirJulgamento) {
    try {
      // ESTEIRA-T12: só PR delegado entra na fila. As linhas com PR (vivas e
      // recém-fechadas) são a prova; sem a lista, o SM cai no comportamento
      // antigo (sem filtro de delegação).
      const sessoesParaReconhecer = options.sessoesParaReconhecerPr ?? options.sessoesVivas
      paraJulgar = await listarPrsSemParecer({
        repository: options.repository,
        gh: (method, path) => gh(method, path),
        cap: options.capJulgamento ?? CAP_PADRAO_DE_JULGAMENTO,
        ...(sessoesParaReconhecer ? { sessoes: sessoesParaReconhecer } : {}),
      })
      if (paraJulgar.length > 0) await options.pedirJulgamento(paraJulgar)
    } catch (err) {
      paraJulgar = []
      falhaAoEnfileirar = (err as Error).message
      const avisar = options.onWarn ?? console.warn
      avisar(
        `[sm] não consegui levantar a fila de julgamento de ${options.repository}; ` +
          `entrega sem parecer pode ficar parada até a próxima acordada: ${falhaAoEnfileirar}`
      )
    }
  }

  // A recusa aparece na saída da missão, e não como silêncio. Relatar uma
  // acordada que tentou e foi recusada como "nada a delegar" seria a mentira
  // mais cara aqui: o descanso pós-acordada-vazia calaria justamente o ciclo
  // que precisa tentar de novo.
  const linhaDaRecusa =
    recusadas.length > 0
      ? `SM: ${recusadas.length} delegation(s) REFUSED by the dev, left unlabelled: ` +
        `${recusadas.map((r) => `#${r.numero} (${r.motivo})`).join('; ')}.`
      : ''

  const linhaDaDelegacao =
    delegated.length > 0
      ? `SM delegated ${delegated.length} ready task(s): ${delegated.map((n) => `#${n}`).join(', ')}.` +
        (sessoes.length > 0 ? ` Dev sessions: ${sessoes.join(', ')}.` : '')
      : 'SM: no newly-ready task to delegate.'
  // ESTEIRA-T12: só PR delegado, aberto e sem parecer entra em `paraJulgar` —
  // Dependabot, PR de humano e PR já mesclado ficam de fora e não são citados.
  const linhaDoJulgamento = falhaAoEnfileirar
    ? `SM: judgment queue FAILED to build (${falhaAoEnfileirar}).`
    : paraJulgar.length > 0
      ? `SM queued ${paraJulgar.length} delegated PR(s) for judgment: ${paraJulgar.map((n) => `#${n}`).join(', ')}.`
      : ''

  return {
    exitCode: 0,
    output: [linhaDaDelegacao, linhaDaRecusa, linhaDoJulgamento].filter(Boolean).join(' '),
    stderr: '',
    // Acordada que encheu a fila do julgamento NÃO é vazia: mandar julgar é
    // trabalho, e tratá-la como no-op faria o descanso pós-acordada-vazia
    // (descanso-apos-vazia.ts) calar justamente o ciclo que destrava entrega.
    // Tentar e ser recusado NÃO é acordada vazia: houve trabalho, houve
    // decisão, e há motivo para acordar de novo em breve.
    noOp:
      delegated.length === 0 &&
      paraJulgar.length === 0 &&
      recusadas.length === 0 &&
      sinalizadasComoResolvidas.length === 0 &&
      !falhaAoEnfileirar,
    delegated,
    paraJulgar,
    travadaPorVaga,
    sinalizadasComoResolvidas,
  }
}
