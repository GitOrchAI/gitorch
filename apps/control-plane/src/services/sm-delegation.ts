import { GithubExecutionError } from './github-backlog.js'
import { aplicarLabelDoAgente } from './agent-label.js'
import { escolherParaDelegar, type IssueCandidata } from './fila-de-delegacao.js'
import type { LinhaDeSessao } from './dev-session-store.js'
import { fetchComTeto } from './fetch-com-teto.js'
import { acharParecerNesteHead } from './parecer-do-qa.js'

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

const TASK_LABEL = 'gitorch:task'

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
 */
export async function listarPrsSemParecer(args: {
  repository: string
  gh: (method: string, path: string) => Promise<unknown>
  cap: number
}): Promise<number[]> {
  if (args.cap <= 0) return []

  const prs = (await args.gh(
    'GET',
    `/repos/${args.repository}/pulls?state=open&sort=created&direction=desc&per_page=${PRS_POR_PAGINA}`
  )) as Array<{ number: number; draft?: boolean; head?: { sha?: string } }>

  const semParecer: number[] = []
  for (const p of Array.isArray(prs) ? prs : []) {
    // Rascunho não é entrega — o julgamento também o pula.
    if (p.draft) continue
    // O cap corta ANTES da leitura das reviews: uma entrega que não caberia
    // nesta acordada não vale uma chamada à API do GitHub.
    if (semParecer.length >= args.cap) break

    const reviews = (await args.gh(
      'GET',
      `/repos/${args.repository}/pulls/${p.number}/reviews?per_page=100`
    )) as Array<{ body?: string; commit_id?: string }>

    if (acharParecerNesteHead(reviews, p.head?.sha)) continue
    semParecer.push(p.number)
  }
  return semParecer
}

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
  }) => Promise<string | null>
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
  fetchImpl?: typeof fetch
  /**
   * Linhas de sessão abertas deste projeto. É a fila real: issue com linha viva
   * já está sendo trabalhada; issue sem linha viva está por delegar, mesmo que
   * já tenha sido delegada antes e a sessão tenha morrido.
   */
  sessoesVivas?: LinhaDeSessao[]
  /** Sessões abertas neste projeto nas últimas 24h, para o teto diário. */
  delegadasHoje?: number
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
  onWarn?: (message: string) => void
}

export interface SmDelegationResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
  delegated: number[]
  /** Entregas abertas sem parecer nosso que este ciclo mandou julgar. */
  paraJulgar: number[]
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
  const f = fetchComTeto(options.fetchImpl ?? fetch)
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
  )) as Array<{ number: number; title?: string; labels: Array<{ name: string }>; body?: string }>
  const abertas = Array.isArray(tasks) ? tasks : []

  // Bloqueadores só para quem ainda não tem sessão viva — não adianta gastar
  // chamada em issue que já está em trabalho.
  const comSessaoViva = new Set((options.sessoesVivas ?? []).map((s) => s.issueNumber))
  const candidatas: IssueCandidata[] = []
  for (const t of abertas) {
    if (comSessaoViva.has(t.number)) continue
    let abertosCount = 0
    for (const b of extractBlockers(t.body ?? '')) {
      const blocker = (await gh('GET', `/repos/${options.repository}/issues/${b}`)) as {
        state?: string
      }
      if (blocker.state !== 'closed') abertosCount += 1
    }
    candidatas.push({ number: t.number, bloqueadoresAbertos: abertosCount })
  }

  const escolhidas = escolherParaDelegar({
    candidatas,
    sessoesVivas: options.sessoesVivas ?? [],
    delegadasHoje: options.delegadasHoje ?? 0,
    tetoConcorrentes: options.tetoConcorrentes ?? 3,
    tetoDiario: options.tetoDiario ?? 15,
    capPorCiclo: cap,
  })
  const porNumero = new Map(abertas.map((t) => [t.number, t]))

  const delegated: number[] = []
  // Identificadores das sessões abertas no dev assíncrono, para o watchdog cobrar.
  const sessoes: string[] = []
  for (const numero of escolhidas) {
    const task = porNumero.get(numero)
    if (!task) continue
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

    // O label marca a issue; a sessão é quem efetivamente põe o dev a
    // trabalhar. Guardamos o identificador na saída da missão para o watchdog
    // ter o que cobrar depois.
    if (options.criarSessaoDev) {
      const sessao = await options.criarSessaoDev({
        repository: options.repository,
        titulo: `#${task.number} ${task.title ?? ''}`.trim(),
        prompt: [
          `Work on issue #${task.number} of ${options.repository}.`,
          '',
          task.body ?? '',
          '',
          'Deliver a pull request that closes the issue and satisfies every item',
          'under "Verification Criteria". Do not change anything outside the scope',
          'described above.',
        ].join('\n'),
      })
      if (sessao) {
        sessoes.push(`#${task.number}→${sessao}`)
        // A ligação tem de ser GUARDADA aqui, não só impressa: é ela que o
        // julgamento consulta depois. O try/catch é deliberado — falhar ao
        // guardar não pode derrubar a delegação das outras tasks, e o aviso
        // diz exatamente o que ficou para trás.
        if (options.aoCriarSessao) {
          try {
            await options.aoCriarSessao({ issueNumber: task.number, sessionName: sessao })
          } catch (err) {
            const avisar = options.onWarn ?? console.warn
            avisar(
              `[sm] sessão criada para #${task.number} mas a ligação não pôde ser guardada; ` +
                `o julgamento não vai encontrar este PR: ${(err as Error).message}`
            )
          }
        }
      }
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
      paraJulgar = await listarPrsSemParecer({
        repository: options.repository,
        gh: (method, path) => gh(method, path),
        cap: options.capJulgamento ?? CAP_PADRAO_DE_JULGAMENTO,
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

  const linhaDaDelegacao =
    delegated.length > 0
      ? `SM delegated ${delegated.length} ready task(s): ${delegated.map((n) => `#${n}`).join(', ')}.` +
        (sessoes.length > 0 ? ` Dev sessions: ${sessoes.join(', ')}.` : '')
      : 'SM: no newly-ready task to delegate.'
  const linhaDoJulgamento = falhaAoEnfileirar
    ? `SM: judgment queue FAILED to build (${falhaAoEnfileirar}).`
    : paraJulgar.length > 0
      ? `SM queued ${paraJulgar.length} PR(s) for judgment: ${paraJulgar.map((n) => `#${n}`).join(', ')}.`
      : ''

  return {
    exitCode: 0,
    output: linhaDoJulgamento ? `${linhaDaDelegacao} ${linhaDoJulgamento}` : linhaDaDelegacao,
    stderr: '',
    // Acordada que encheu a fila do julgamento NÃO é vazia: mandar julgar é
    // trabalho, e tratá-la como no-op faria o descanso pós-acordada-vazia
    // (descanso-apos-vazia.ts) calar justamente o ciclo que destrava entrega.
    noOp: delegated.length === 0 && paraJulgar.length === 0 && !falhaAoEnfileirar,
    delegated,
    paraJulgar,
  }
}
