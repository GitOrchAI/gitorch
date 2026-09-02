// ESTEIRA-T9 (SUPERSEDE 8ca431a5): um incidente de infra = UMA issue = UM PR, e
// fecha sozinho quando o workflow volta a ficar verde. Medido: os incidentes
// #24/#188/#216 eram o MESMO bug do Dependabot, abertos de novo a cada
// varredura porque nada olhava se já tinha issue/PR e nada fechava quando sarava.
//
// Duas regras PURAS (sem rede) + uma varredura com deps injetadas.

/** A linha de `infra_incidents` que interessa para decidir o fechamento. */
export interface IncidenteAberto {
  id: string
  projectId: string
  classe: string
  identidadeEstavel: string
  issueNumber: number | null
  prNumber: number | null
  clearedAt: Date | null
  /**
   * L4-T1: primeiro avistamento do incidente (`infra_incidents.first_seen_at`).
   * Usado como piso de "desde quando" ao ler runs do workflow quando ainda
   * não há `mergedAt` (PR não lido de volta pela API do GitHub).
   */
  firstSeenAt: Date
  /** ESTEIRA-T10: quantos PRs já fracassaram em resolver este incidente. */
  prAttempts?: number
  /** ESTEIRA-T10: quando o incidente foi escalado (parou de insistir). */
  escalatedAt?: Date | null
}

// --- ESTEIRA-T10: incidente que resiste a 3 PRs ---------------------------

/** Ao 3º PR fracassado sem resolver, o GitOrch para de insistir e escala. */
export const TENTATIVAS_ATE_ESCALAR = 3

export interface DecisaoDeEscalonamento {
  /** Um PR fracassou (fechado sem merge / rejeitado) — conta +1 tentativa. */
  incrementarTentativa: boolean
  /** Atingiu o teto: seta `escalated_at`, para de delegar, roda o retro. */
  escalar: boolean
  motivo: string
}

/**
 * Regra pura. `prFalhou` = o PR ligado ao incidente foi fechado sem merge (ou
 * rejeitado no julgamento). Ao chegar em `TENTATIVAS_ATE_ESCALAR` sem
 * `cleared_at`, escala uma vez (não re-escala).
 */
export function decidirEscalonamento(
  inc: Pick<IncidenteAberto, 'clearedAt' | 'escalatedAt'> & { prAttempts?: number },
  prFalhou: boolean
): DecisaoDeEscalonamento {
  if (inc.clearedAt) {
    return { incrementarTentativa: false, escalar: false, motivo: 'incidente já resolvido' }
  }
  if (inc.escalatedAt) {
    return { incrementarTentativa: false, escalar: false, motivo: 'já escalado' }
  }
  if (!prFalhou) {
    return { incrementarTentativa: false, escalar: false, motivo: 'PR ainda vivo ou mesclado' }
  }
  const tentativasDepois = (inc.prAttempts ?? 0) + 1
  return {
    incrementarTentativa: true,
    escalar: tentativasDepois >= TENTATIVAS_ATE_ESCALAR,
    motivo:
      tentativasDepois >= TENTATIVAS_ATE_ESCALAR
        ? `${tentativasDepois} PRs fracassados — o obstáculo é o mesmo toda vez`
        : `${tentativasDepois}º PR fracassado`,
  }
}

/** Situação atual da causa, relida do GitHub na varredura. */
export interface SituacaoDoIncidente {
  /** A ÚLTIMA run do workflow (identidade `wf:<id>`) na branch default é verde? */
  ultimaRunVerde: boolean
  /** Já rodou ALGUMA run depois de o PR entrar? (sem isso, "verde" é a run velha). */
  rodouDepoisDoPr: boolean
  /** O PR ligado ao incidente foi mesclado? */
  prMesclado: boolean
  /**
   * ESTEIRA-T10: o PR ligado foi FECHADO sem merge (ou o julgamento reprovou).
   * É o sinal de "mais um PR fracassou" — conta +1 tentativa.
   */
  prFechadoSemMerge?: boolean
  /**
   * L4-T1: o workflow desta identidade ainda existe no repositório?
   * `undefined` = não foi possível verificar (não afirma nada). `false` = o
   * workflow foi removido (ex.: `.github/workflows/<arquivo>.yml` apagado ou
   * arquivado) — nesse caso NUNCA mais vai existir uma run verde para provar
   * o conserto, e a ausência do workflow É a prova de que o incidente acabou.
   */
  workflowExiste?: boolean
  /**
   * L4-T1: alguma run do workflow FALHOU desde o conserto (PR mesclado, ou
   * desde `firstSeenAt` quando ainda não há `mergedAt`)? Caso real (#3681,
   * `jules-api-retry.yml`): o workflow passou a só disparar runs "skipped"
   * depois do PR — nunca "success" — então `ultimaRunVerde` nunca fica true,
   * mas também nunca mais falhou. A prova de resolvido aqui é negativa: não
   * houve falha, não é "ficou verde".
   */
  houveFalhaDesdeOPr?: boolean
}

export interface DecisaoDeFechamento {
  /** Fechar a issue no GitHub (`state: closed`). */
  fecharIssue: boolean
  /** Marcar `infra_incidents.cleared_at` — o incidente acabou. */
  limparIncidente: boolean
  motivo: string
}

/**
 * Regra pura. O incidente só está RESOLVIDO quando a prova é positiva: a última
 * run do workflow ficou verde DEPOIS de o conserto entrar. "PR mesclado" sozinho
 * não basta — o merge pode não ter consertado, ou a run nem rodou ainda.
 */
export function decidirFechamentoDeIncidente(
  inc: IncidenteAberto,
  sit: SituacaoDoIncidente
): DecisaoDeFechamento {
  if (inc.clearedAt) {
    return { fecharIssue: false, limparIncidente: false, motivo: 'já estava limpo' }
  }

  // L4-T1: o workflow que causava o incidente não existe mais no repositório
  // — não há mais run nenhuma para provar "ficou verde", e esperar por uma
  // deixaria o incidente aberto para sempre. Prioridade sobre qualquer outra
  // regra: a ausência do workflow É a prova de que o incidente acabou.
  //
  // L4-T1b (achado 3 da auditoria, ACEITO — regra não muda): sim, quem apaga
  // o arquivo do workflow induz este fechamento. Aceito porque só um
  // MANTENEDOR do repositório do cliente tem permissão de apagar workflow; o
  // motivo fica explícito no comentário de fechamento (auditável); a issue
  // pode ser reaberta manualmente a qualquer momento; e sem o workflow não
  // sobra nada para este incidente monitorar de qualquer forma.
  if (sit.workflowExiste === false) {
    return { fecharIssue: true, limparIncidente: true, motivo: 'workflow removido do repositório' }
  }

  // Só para o job do Dependabot / alerta de segurança não existe "run do
  // workflow" — nesses a prova é o PR mesclado (o updater volta a rodar sozinho).
  const semRunDeWorkflow =
    inc.identidadeEstavel === 'dependabot:updates' ||
    inc.identidadeEstavel.startsWith('dependabot:') ||
    inc.identidadeEstavel.startsWith('sec:')

  if (semRunDeWorkflow) {
    return inc.prNumber && sit.prMesclado
      ? { fecharIssue: true, limparIncidente: true, motivo: 'PR de infra mesclado' }
      : { fecharIssue: false, limparIncidente: false, motivo: 'aguardando merge do PR' }
  }

  if (sit.ultimaRunVerde && sit.rodouDepoisDoPr) {
    return { fecharIssue: true, limparIncidente: true, motivo: 'workflow verde depois do conserto' }
  }
  // L4-T1 (fix-up crítico): "nenhuma falha" só prova conserto se o workflow
  // JÁ RODOU depois do PR. Sem `rodouDepoisDoPr`, "nenhuma run" e "nenhuma
  // falha" são a MESMA coisa — fechar aqui fecharia às 14h (PR mesclado,
  // workflow ainda não rodou) e o workflow falharia às 15h com o incidente
  // já fechado. Por isso este `if` vem ANTES e barra o caso sem run.
  if (sit.prMesclado && !sit.rodouDepoisDoPr) {
    return {
      fecharIssue: false,
      limparIncidente: false,
      motivo: 'PR mesclado, esperando a próxima run do workflow',
    }
  }
  // L4-T1: caso real (#3681, jules-api-retry.yml) — o workflow passou a só
  // disparar runs "skipped" depois do conserto, nunca "success", então
  // `ultimaRunVerde` nunca fica true. Quando dá para provar que NÃO houve
  // falha desde o PR (e o workflow já rodou de novo — checado acima), isso
  // já basta — não exige um verde que pode nunca vir.
  if (sit.prMesclado && sit.rodouDepoisDoPr && sit.houveFalhaDesdeOPr === false) {
    return {
      fecharIssue: true,
      limparIncidente: true,
      motivo: 'sem falha do workflow desde a correção',
    }
  }
  return { fecharIssue: false, limparIncidente: false, motivo: 'nada mudou' }
}

// --- L4-T1 (fix-up): calcular `rodouDepoisDoPr` como função pura testável -

/** Um run de workflow do GitHub Actions, só os campos que interessam aqui. */
export interface RunDoWorkflowParaCorte {
  conclusion?: string | null
  run_started_at?: string
  created_at?: string
}

/**
 * Regra pura. Havia alguma run do workflow CONCLUÍDA (`conclusion` não nulo —
 * `success`, `failure`, `skipped`, `cancelled`, etc. todas contam) desde
 * `desde` (ISO 8601, tipicamente `mergedAt ?? firstSeenAt`)?
 *
 * `skipped` conta como "rodou" de propósito: o caso real #3681
 * (`jules-api-retry.yml`) passou a só disparar runs "skipped" desde o
 * conserto, nunca "success" — e mesmo assim isso prova que o workflow voltou
 * a rodar depois do PR, o que é exatamente o que `rodouDepoisDoPr` precisa
 * responder. Uma run ainda em andamento (`conclusion` nulo/undefined) não
 * conta — ela não terminou, não prova nada ainda.
 */
export function houveRunConcluidaDesde(runs: RunDoWorkflowParaCorte[], desde: string): boolean {
  return runs.some((r) => {
    if (!r.conclusion) return false
    const quando = r.run_started_at ?? r.created_at
    return quando !== undefined && quando >= desde
  })
}

// --- L4-T1: casar identidade legada (ci:<nome>) com o workflow real -------

/**
 * Normaliza um nome de workflow para comparação robusta: sem acento, minúsculo,
 * pontuação vira espaço, espaços colapsados e sem sobra nas bordas. É o que
 * permite casar `w.name` (GitHub) com o nome extraído da identidade legada
 * sem que maiúscula, acento ou pontuação decidam um "não bate" falso.
 */
export function normalizarNomeDeWorkflow(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Incidentes antigos (antes de `wf:<id>`) guardam a identidade como
 * `ci:<nome de exibição>`, às vezes com um travessão separando um subtítulo
 * (ex.: `ci:Jules API Retry — re-dispara via API direta`). Extrai só o nome
 * do workflow (antes do travessão) para casar com `actions/workflows[].name`
 * — devolve `null` para qualquer identidade que não seja `ci:` (`wf:`,
 * `dependabot:`, `sec:`), que não são "legadas" neste sentido.
 */
export function nomeDoWorkflowNaIdentidadeLegada(identidadeEstavel: string): string | null {
  const m = identidadeEstavel.match(/^ci:(.+)$/)
  const bruto = m?.[1]
  if (bruto === undefined) return null
  const antesDoTracejado = bruto.split(/\s+—\s+/)[0] ?? bruto
  return antesDoTracejado.trim()
}

/** Um achado tal como o sensor devolve, para o agrupamento por causa. */
export interface AchadoParaAgrupar {
  identidadeEstavel: string
  paths: string[]
  /** Assinatura curta do erro (ex.: primeira linha significativa do log). */
  assinaturaDeErro?: string
}

/**
 * Regra pura. Dois achados são a MESMA causa quando compartilham arquivo E a
 * assinatura de erro bate — aí viram UM `infra_incidents`, não dois. (O caso
 * #24/#188/#216: mesmo `.github/workflows/dependabot-to-jules.yml`, mesmo
 * "npm ci" quebrado.)
 */
// --- L4-T1b: comentário de fechamento pela MESMA guarda do fechamento -----

export interface ComentarFechamentoDeps {
  /**
   * POST guardado — em `scheduler.ts` é o `ghPost` que passa por
   * `ghComGuarda` (`guardaPorRepositorio`), o MESMO caminho do `ghPatch` que
   * fecha a issue. NUNCA `fetch` cru: era assim que, em projeto
   * 'so-olhar' (autonomia que barra escrita), o PATCH de fechamento era
   * recusado mas o comentário era gravado do mesmo jeito — a guarda de
   * autonomia valia para metade da ação, não para a ação inteira.
   */
  postarComentario: (path: string, body: unknown) => Promise<void>
  /** Falha do POST NUNCA desaparece em silêncio — vira warn com contexto (nunca o token). */
  onWarn?: (mensagem: string) => void
}

/**
 * L4-T1b (achado 1 da auditoria de segurança): grava o comentário de
 * fechamento pelo mesmo caminho guardado do PATCH que fecha a issue. Best-
 * effort quanto ao RESULTADO da varredura (uma falha aqui não derruba o
 * fechamento da issue, que já aconteceu antes desta chamada) — mas a falha
 * em si é sempre reportada via `onWarn`, nunca engolida com um `.catch(() =>
 * undefined)` mudo.
 */
export async function comentarFechamentoDeIncidente(
  repo: string,
  issueNumber: number,
  comentario: string,
  deps: ComentarFechamentoDeps
): Promise<void> {
  try {
    await deps.postarComentario(`/repos/${repo}/issues/${issueNumber}/comments`, {
      body: comentario,
    })
  } catch (err) {
    deps.onWarn?.(
      `comentar-fechamento-de-incidente: ${repo}#${issueNumber} — ${String(err).slice(0, 200)}`
    )
  }
}

export function mesmaCausa(a: AchadoParaAgrupar, b: AchadoParaAgrupar): boolean {
  if (a.identidadeEstavel === b.identidadeEstavel) return true
  const pathsA = new Set(a.paths)
  const compartilhaPath = b.paths.some((p) => pathsA.has(p))
  if (!compartilhaPath) return false
  const sa = (a.assinaturaDeErro ?? '').trim().toLowerCase()
  const sb = (b.assinaturaDeErro ?? '').trim().toLowerCase()
  if (!sa || !sb) return compartilhaPath // sem assinatura: path compartilhado já agrupa
  return sa === sb || sa.includes(sb) || sb.includes(sa)
}

/** Agrupa uma leva de achados: devolve uma "identidade canônica" por grupo. */
export function agruparPorCausa(achados: AchadoParaAgrupar[]): Map<string, string> {
  const canonicoPor = new Map<string, string>()
  const grupos: AchadoParaAgrupar[][] = []
  for (const achado of achados) {
    const grupo = grupos.find((g) => g.some((x) => mesmaCausa(x, achado)))
    if (grupo) grupo.push(achado)
    else grupos.push([achado])
  }
  for (const g of grupos) {
    const canonico = g[0]?.identidadeEstavel ?? ''
    for (const a of g) canonicoPor.set(a.identidadeEstavel, canonico)
  }
  return canonicoPor
}

// --- Varredura -----------------------------------------------------------

export interface VarrerIncidentesResolvidosDeps {
  listarAbertos: () => Promise<IncidenteAberto[]>
  /**
   * ESTEIRA-T9/T10 (elo que faltava): liga o incidente ao PR que a delegação
   * abriu. O `pr_number` NÃO nasce com o incidente (não há PR ainda) e não era
   * gravado em nenhum outro ponto — sem esta ligação, `situacaoDoIncidente`
   * nunca via o PR e T9 (fechar sozinho) / T10 (contar tentativa, escalar)
   * ficavam inertes. O número mora em `dev_sessions.pull_request_number` da
   * sessão que trabalhou a issue. Devolve o número (e o persiste em
   * `infra_incidents.pr_number`) ou `null`. Só é chamada para incidente ainda
   * sem `prNumber`.
   */
  descobrirPrDoIncidente?: (inc: IncidenteAberto) => Promise<number | null>
  /** Relê o GitHub: última run do workflow + estado do PR. */
  situacaoDoIncidente: (inc: IncidenteAberto) => Promise<SituacaoDoIncidente>
  /** Fecha a issue no GitHub (best-effort). */
  fecharIssue: (issueNumber: number, comentario: string) => Promise<void>
  /** Marca `infra_incidents.cleared_at = now` — o incidente acabou. */
  limparIncidente: (id: string) => Promise<void>
  /**
   * ESTEIRA-T10: `infra_incidents.pr_attempts += 1` — mais um PR fracassou.
   * O chamador zera `pr_number` junto para uma nova tentativa poder nascer.
   */
  incrementarTentativa?: (id: string) => Promise<void>
  /**
   * ESTEIRA-T10: atingiu 3 PRs fracassados — seta `escalated_at`, para de
   * insistir e avisa o dono UMA vez (só o MARCO, nunca o detalhe técnico).
   */
  escalar?: (args: { id: string; issueNumber: number | null; motivo: string }) => Promise<void>
  /** Grava o aprendizado quando um incidente é RESOLVIDO (classe + como sarou). */
  registrarResolucao?: (args: {
    projectId: string
    classe: string
    identidadeEstavel: string
    comoSarou: string
  }) => Promise<void>
  teto?: number
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface VarrerIncidentesResolvidosResultado {
  fechados: string[]
  escalados: string[]
  aindaAbertos: number
}

export const TETO_DE_INCIDENTES_POR_VARREDURA = 20

export async function varrerIncidentesResolvidos(
  deps: VarrerIncidentesResolvidosDeps
): Promise<VarrerIncidentesResolvidosResultado> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const teto = deps.teto ?? TETO_DE_INCIDENTES_POR_VARREDURA
  const res: VarrerIncidentesResolvidosResultado = { fechados: [], escalados: [], aindaAbertos: 0 }

  let abertos: IncidenteAberto[]
  try {
    abertos = (await deps.listarAbertos()).slice(0, teto)
  } catch (err) {
    warn(`varrer-incidentes: não li os incidentes abertos (${String(err).slice(0, 120)})`)
    return res
  }

  for (const inc of abertos) {
    try {
      // Liga o incidente ao PR da delegação ANTES de decidir — sem isto o
      // resto da varredura enxerga `prNumber: null` e nada fecha nem escala.
      if (inc.prNumber == null && inc.issueNumber !== null && deps.descobrirPrDoIncidente) {
        try {
          const pr = await deps.descobrirPrDoIncidente(inc)
          if (pr != null) inc.prNumber = pr
        } catch (err) {
          warn(
            `varrer-incidentes: não liguei ${inc.identidadeEstavel} a um PR (${String(err).slice(0, 120)})`
          )
        }
      }

      const sit = await deps.situacaoDoIncidente(inc)
      const decisao = decidirFechamentoDeIncidente(inc, sit)
      if (decisao.limparIncidente) {
        if (decisao.fecharIssue && inc.issueNumber !== null) {
          await deps.fecharIssue(
            inc.issueNumber,
            `Incidente de infra resolvido (${decisao.motivo}) — fechado automaticamente pelo GitOrch.`
          )
        }
        await deps.limparIncidente(inc.id)
        await deps
          .registrarResolucao?.({
            projectId: inc.projectId,
            classe: inc.classe,
            identidadeEstavel: inc.identidadeEstavel,
            comoSarou: decisao.motivo,
          })
          .catch(() => undefined)
        res.fechados.push(inc.identidadeEstavel)
        info(`varrer-incidentes: ${inc.identidadeEstavel} resolvido (${decisao.motivo})`)
        continue
      }

      // ESTEIRA-T10: não resolveu — mais um PR fracassou? conta a tentativa, e
      // ao 3º escala (para de insistir + avisa o dono uma vez).
      res.aindaAbertos += 1
      const esc = decidirEscalonamento(inc, sit.prFechadoSemMerge === true)
      if (esc.incrementarTentativa) await deps.incrementarTentativa?.(inc.id)
      if (esc.escalar) {
        await deps.escalar?.({ id: inc.id, issueNumber: inc.issueNumber, motivo: esc.motivo })
        res.escalados.push(inc.identidadeEstavel)
        info(`varrer-incidentes: ${inc.identidadeEstavel} escalado (${esc.motivo})`)
      }
    } catch (err) {
      warn(`varrer-incidentes: ${inc.identidadeEstavel} falhou (${String(err).slice(0, 120)})`)
      res.aindaAbertos += 1
    }
  }
  return res
}
