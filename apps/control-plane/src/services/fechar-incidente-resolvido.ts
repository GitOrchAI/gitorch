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
}

/** Situação atual da causa, relida do GitHub na varredura. */
export interface SituacaoDoIncidente {
  /** A ÚLTIMA run do workflow (identidade `wf:<id>`) na branch default é verde? */
  ultimaRunVerde: boolean
  /** Já rodou ALGUMA run depois de o PR entrar? (sem isso, "verde" é a run velha). */
  rodouDepoisDoPr: boolean
  /** O PR ligado ao incidente foi mesclado? */
  prMesclado: boolean
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
  if (sit.prMesclado && !sit.rodouDepoisDoPr) {
    return {
      fecharIssue: false,
      limparIncidente: false,
      motivo: 'PR mesclado, esperando a próxima run do workflow',
    }
  }
  return { fecharIssue: false, limparIncidente: false, motivo: 'nada mudou' }
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
  /** Relê o GitHub: última run do workflow + estado do PR. */
  situacaoDoIncidente: (inc: IncidenteAberto) => Promise<SituacaoDoIncidente>
  /** Fecha a issue no GitHub (best-effort). */
  fecharIssue: (issueNumber: number, comentario: string) => Promise<void>
  /** Marca `infra_incidents.cleared_at = now`. */
  limparIncidente: (id: string) => Promise<void>
  teto?: number
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface VarrerIncidentesResolvidosResultado {
  fechados: string[]
  aindaAbertos: number
}

export const TETO_DE_INCIDENTES_POR_VARREDURA = 20

export async function varrerIncidentesResolvidos(
  deps: VarrerIncidentesResolvidosDeps
): Promise<VarrerIncidentesResolvidosResultado> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const teto = deps.teto ?? TETO_DE_INCIDENTES_POR_VARREDURA
  const res: VarrerIncidentesResolvidosResultado = { fechados: [], aindaAbertos: 0 }

  let abertos: IncidenteAberto[]
  try {
    abertos = (await deps.listarAbertos()).slice(0, teto)
  } catch (err) {
    warn(`varrer-incidentes: não li os incidentes abertos (${String(err).slice(0, 120)})`)
    return res
  }

  for (const inc of abertos) {
    try {
      const sit = await deps.situacaoDoIncidente(inc)
      const decisao = decidirFechamentoDeIncidente(inc, sit)
      if (!decisao.limparIncidente) {
        res.aindaAbertos += 1
        continue
      }
      if (decisao.fecharIssue && inc.issueNumber !== null) {
        await deps.fecharIssue(
          inc.issueNumber,
          `Incidente de infra resolvido (${decisao.motivo}) — fechado automaticamente pelo GitOrch.`
        )
      }
      await deps.limparIncidente(inc.id)
      res.fechados.push(inc.identidadeEstavel)
      info(`varrer-incidentes: ${inc.identidadeEstavel} resolvido (${decisao.motivo})`)
    } catch (err) {
      warn(`varrer-incidentes: ${inc.identidadeEstavel} falhou (${String(err).slice(0, 120)})`)
      res.aindaAbertos += 1
    }
  }
  return res
}
