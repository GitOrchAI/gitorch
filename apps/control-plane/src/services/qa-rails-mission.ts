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
import { aplicarLabelDoAgente } from './agent-label.js'
import type { CardMover } from './board-status.js'
import { ehPrDelegado } from './pr-delegado.js'
import type { LinhaDeSessao } from './dev-session-store.js'
import { lerDiffDoPr, type ArquivoDoPr } from './diff-do-pr.js'
import { mesclarPr, type ResultadoDoMerge } from './merge-do-pr.js'

// Missão do QA nos TRILHOS (F3.6): acha a PR do Jules que precisa de julgamento,
// monta o snapshot (diff + Verification Criteria da issue + estado do CI), o
// motor preenche UM formulário de veredito, e o SISTEMA posta a review e — se
// for rework — o comentário mencionando @jules. A LLM nunca toca no GitHub.

const JULES_MARKER = '<!-- gitorch:qa -->'
/**
 * Substring EXATA do texto que a review de APROVAÇÃO posta (ver a montagem
 * do corpo mais abaixo, no ramo `effectiveVerdict === 'approve'`). É o que
 * permite ao laço de descoberta (C1, revisão final) diferenciar, entre as
 * reviews MARCADAS (com `JULES_MARKER`) já postadas no mesmo head, uma
 * aprovação de uma reprovação — sem isto as duas ficam indistinguíveis e um
 * PR aprovado cujo merge o GitHub recusou fica pulado para sempre, do mesmo
 * jeito que um PR reprovado esperando rework.
 */
const APPROVAL_VERDICT_MARKER = 'verdict: APPROVE'

export interface QaRailsMissionOptions {
  repository: string
  githubToken: string
  execute: (prompt: string) => Promise<string>
  contextBlocks?: string[]
  /** Move o card da issue vinculada no board conforme o veredito (opcional). */
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
   * Fecha a linha da sessão do dev assíncrono quando o PR dela é mesclado.
   *
   * Sem isto o merge acontece mas a vigia (dev-session-store) nunca fica
   * sabendo: a linha continua "viva" para sempre, `filtroDeSessoesParaJulgamento`
   * segue candidatando-a e o QA voltaria a procurar veredito para um PR que já
   * foi mesclado. `fecharSessao` com o motivo `'merged'` é quem tira a linha da
   * vigia — decisão de quem chama (o scheduler conhece o Prisma), não deste
   * módulo, que não sabe nada de banco.
   */
  aoMesclar?: (args: { numeroDoPr: number }) => Promise<void>
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
  onWarn?: (message: string) => void
}

export interface QaRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
  noOp?: boolean
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

export async function runQaMissionViaRails(
  options: QaRailsMissionOptions
): Promise<QaRailsMissionResult> {
  const f = options.fetchImpl ?? fetch
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

  // 1) PRs abertas de dev assíncrono delegado (o gatilho do QA). O AUTOR não é
  // sinal confiável — visto em produção: o Jules abre o PR pela conta do dono
  // da instalação. O sinal nativo do GitOrch é o PR fechar uma issue com a
  // label de delegação; o login com "jules" fica só como atalho.
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
  for (const p of Array.isArray(prs) ? prs : []) {
    if (p.draft) continue

    // A consulta à issue só acontece no recuo 3, e só quando há palavra de
    // ligação — o caminho autoritativo (linha guardada) não gasta chamada
    // nenhuma.
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
    if (!veredito.delegado) continue

    // Não re-julgar o MESMO estado a cada wake: se já há review nossa neste
    // head, o dev ainda não retrabalhou — julgar de novo só faria spam.
    //
    // C1 (revisão final): EXCETO quando essa review marcada é uma
    // APROVAÇÃO. Aprovação postada + PR ainda ABERTO (este laço só olha PRs
    // `state=open`) é PROVA de que o merge não aconteceu — o GitHub recusou
    // (405, proteção de branch) ou o produto não pôde aprovar a própria PR
    // e a review virou COMMENT. Tratar isso como "já julgado" era um beco
    // sem saída permanente: a linha da sessão nunca fecha, a issue nunca
    // volta à fila, e a vigia dispara o QA para sempre sem nunca reentar o
    // merge — o defeito das 85 execuções cegas ressuscitado. Um PR
    // REPROVADO cujo dev ainda não retrabalhou continua pulado normalmente:
    // é o que evita spam de re-julgamento.
    const reviews = (await gh(
      'GET',
      `/repos/${options.repository}/pulls/${p.number}/reviews?per_page=100`
    )) as Array<{ body?: string; commit_id?: string }>
    const reviewMarcadaNesteHead = Array.isArray(reviews)
      ? reviews.find(
          (r) =>
            (r.body ?? '').includes(JULES_MARKER) && (!p.head?.sha || r.commit_id === p.head.sha)
        )
      : undefined
    const foiAprovacao = Boolean(
      reviewMarcadaNesteHead &&
      (reviewMarcadaNesteHead.body ?? '').includes(APPROVAL_VERDICT_MARKER)
    )
    if (reviewMarcadaNesteHead && !foiAprovacao) continue

    target = p
    issueDaEntrega = veredito.issueNumber
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
  // chamadas com a issue vinculada e o diff — porque um dos dois estados
  // abaixo (`pending`/`unknown`) faz a missão voltar sem julgar nada; não há
  // por que buscar critérios e diff de um PR que não vai ser julgado agora.
  let ciState = 'unknown'
  if (pr.head?.sha) {
    const checks = (await gh(
      'GET',
      `/repos/${options.repository}/commits/${pr.head.sha}/check-runs`
    )) as { check_runs?: Array<{ conclusion?: string; status?: string }> }
    const runs = checks.check_runs ?? []
    if (runs.length === 0) ciState = 'no checks'
    else if (runs.some((r) => r.status !== 'completed')) ciState = 'pending'
    else if (runs.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral'))
      ciState = 'green'
    else ciState = 'red'
  }

  // Defeito real de produção (PR #97, 15/08/2026 16:42:22): o QA julgou este
  // PR ENQUANTO a verificação ainda rodava (`ciState === 'pending'`),
  // reprovou com "CI pending", e minutos depois a verificação terminou 100%
  // verde (8 checks) — mas a reprovação ficou PRESA para sempre: o skip de
  // "já julgado" (mais acima, mesmo head sha) nunca deixa o QA re-julgar o
  // mesmo estado, então um motivo TRANSITÓRIO virou um bloqueio PERMANENTE.
  // `pending` não é um veredito ("aprovado"/"reprovado") — é "ainda não
  // sei", e julgar mesmo assim foi o erro. A correção: pular esta passagem
  // (nenhuma review postada, nenhum comentário, nenhum merge) e deixar a
  // PRÓXIMA execução do QA — o scheduler roda em ciclo — encontrar a
  // verificação já resolvida.
  //
  // `unknown` (não deu para ler check-runs porque o GitHub não devolveu o
  // sha do head) entra no MESMO pulo, pelo MESMO motivo: julgar sem saber
  // corre exatamente o mesmo risco de travar um PR para sempre com uma
  // reprovação possivelmente incorreta — é o defeito do PR #97 por uma porta
  // diferente. Isto é DIFERENTE de `no checks`: aquele é um estado ESTÁVEL
  // (o repositório simplesmente não tem verificação nenhuma configurada, e
  // não passa a ter uma só de o QA esperar), então continua sendo julgado e
  // gerando a lacuna GITORCH-GAP (ver adiante). `unknown` não tem NENHUMA
  // evidência sobre qual dos quatro estados é o real — errar para o lado de
  // não agir agora é mais seguro que errar para o lado de uma reprovação
  // permanente e talvez errada.
  if (ciState === 'pending' || ciState === 'unknown') {
    const motivo =
      ciState === 'pending'
        ? 'aguardando a verificação automática terminar'
        : 'não julgado — não foi possível ler o estado da verificação automática (unknown)'
    return {
      exitCode: 0,
      output: `QA: PR #${target.number} ${motivo}.`,
      stderr: '',
      noOp: true,
    }
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
    const found = (issue.body ?? '').match(
      /##\s*Verification Criteria\s*\n+([\s\S]*?)(?:\n##\s|$)/i
    )
    if (found?.[1]) criteria = found[1].trim()
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
  const effectiveVerdict =
    verdict.verdict === 'approve' && (ciState !== 'green' || truncado)
      ? 'request_changes'
      : verdict.verdict

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
  const reviewEvent = effectiveVerdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES'

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

  if (effectiveVerdict === 'approve') {
    // Caminho resiliente (o GitHub decide se pode aprovar) + o campo do padrão
    // Shrimp: o resumo do veredito é o Goal.
    await postarReview(
      reviewEvent,
      `${JULES_MARKER}\nGitOrch QA verdict: APPROVE — criteria met, CI green.\n\n${verdict.comment.goal}`
    )

    // Os TRÊS porteiros (QA aprovou, CI verde, diff completo) já foram
    // satisfeitos para chegar aqui — `mesclarPr` os reconfere de propósito:
    // é o guarda final antes de tocar no repositório do cliente, não uma
    // confiança cega no que a trava de cima já decidiu.
    resultadoDoMerge = await mesclarPr({
      numeroDoPr: target.number,
      ciState,
      vereditoDoQa: effectiveVerdict,
      diffTruncado: truncado,
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
        await gh('PUT', `/repos/${options.repository}/pulls/${target.number}/merge`, {
          merge_method: 'squash',
          sha: pr.head?.sha,
        })
        return true
      },
    })
    if (resultadoDoMerge.mesclado && options.aoMesclar) {
      await options.aoMesclar({ numeroDoPr: target.number })
    }
  } else {
    await postarReview(
      reviewEvent,
      `${JULES_MARKER}\nGitOrch QA verdict: REQUEST CHANGES (see comment).`
    )
    await gh('POST', `/repos/${options.repository}/issues/${target.number}/comments`, {
      body: buildJulesReworkComment(verdict.comment),
    })

    // Task 10 (decisão do dono 14/08/2026): "tem que ter lógica entre jules e
    // QA". O comentário acima morre no PR — o dev assíncrono não lê o PR
    // dele. Entrega a MESMA reprovação na sessão viva para ele retrabalhar.
    // Sem linha correspondente (PR de humano, ou anterior a esta mudança), a
    // missão segue sem avisar — não é falha.
    if (options.avisarSessao) {
      // A linha pode ainda não ter o PR gravado: quem grava é a vigia, e ela
      // roda em outro ciclo. Medido em produção (15/08/2026): o QA julgou o
      // PR #97 às 16:42:22 (achou a delegação pelo recuo do corpo — "Fixes
      // #74" — porque a linha guardada ainda não tinha o PR) e a vigia só
      // gravou `pullRequestNumber = 97` às 16:45:01. Buscando só por PR, o
      // `find` não achava nada e nada era enviado ao dev: as 14 atividades da
      // sessão terminavam em "concluída" às 16:40:34, sem nenhum aviso nosso
      // depois — o trabalho parava em silêncio, o mesmo destino do PR #79 (5
      // dias parado), reproduzido ao vivo. A issue de origem o QA já conhece
      // neste instante (`issueDaEntrega`, resolvida no laço de descoberta
      // acima), então ela entra como SEGUNDA tentativa — não substitui a
      // busca por PR, que é inequívoca (um PR só tem uma linha) e continua
      // sendo a primeira. Quando `issueDaEntrega` é `null` (recuo por login
      // do autor — `ehPrDelegado` não tem como saber a issue nesse recuo), só
      // a busca por PR vale mesmo.
      //
      // `LinhaDeSessao` não expõe `closedAt` (só `dev-session-store.ts`
      // grava; o tipo devolvido aqui é deliberadamente estreito), então não
      // há como filtrar "só viva" dentro deste módulo. Em vez disso, `find`
      // pega a PRIMEIRA linha da issue na ordem em que `options.sessoes`
      // chegou — documentada acima como `createdAt` decrescente. O índice
      // único parcial `dev_sessions_open_per_issue` garante no máximo UMA
      // sessão viva por issue ao mesmo tempo, então a linha mais recente para
      // essa issue É a viva (ou a única candidata, se todas já fecharam) —
      // resolve "prefira a viva/mais recente" sem precisar do campo que o
      // tipo não tem.
      const linha =
        (options.sessoes ?? []).find((s) => s.pullRequestNumber === target.number) ??
        (issueDaEntrega !== null
          ? (options.sessoes ?? []).find((s) => s.issueNumber === issueDaEntrega)
          : undefined)
      if (linha) {
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
          .avisarSessao({ sessionName: linha.sessionName, texto })
          .catch(() => false)
        if (!avisou) {
          const avisar = options.onWarn ?? console.warn
          avisar(
            `[qa] veredito postado no PR #${target.number}, mas a sessão ` +
              `${linha.sessionName} não foi avisada — o dev não vai retrabalhar sozinho`
          )
        }
      }
    }
  }

  // 4b) O QA acabou de julgar: marca a issue VINCULADA (não a PR) como sua,
  // tirando quem estava com ela antes (ex.: gitorch:agent:jules, o dev
  // assíncrono que abriu o PR). Best-effort: aplicarLabelDoAgente nunca lança
  // — o veredito já foi postado acima, isso é só sinalização.
  if (linkedIssue) {
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

  // 5) O board acompanha o veredito: aprovado = pronto pelo padrão do GitOrch
  // (critérios atendidos + CI verde) → "done"; rework → volta a "inProgress".
  // Best-effort: board sem coluna/campo nunca derruba o julgamento já postado.
  let cardNote = ''
  if (options.moveCard && linkedIssue) {
    try {
      const moved = await options.moveCard(
        Number(linkedIssue),
        effectiveVerdict === 'approve' ? 'done' : 'inProgress'
      )
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
  }
}
