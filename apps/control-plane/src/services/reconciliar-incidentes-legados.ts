// L4-T1: incidentes abertos ANTES de `infra_incidents` existir (ou por uma
// varredura que falhou em registrar a linha) ficam com a issue no GitHub mas
// sem nenhuma linha correspondente no banco — e sem linha, `fechar-incidente-
// resolvido.ts` nunca os enxerga, nunca fecha sozinho. A marca
// `<!-- gitorch:incident:<identidade> -->` já vai no corpo de toda issue de
// incidente (ver `criarIssueNoCliente`/`ghIssue`); esta varredura lê essas
// issues de volta e recria a linha que falta. Idempotente: roda toda vez,
// antes de `varrerIncidentesResolvidos`, e só cria o que ainda não existe.

import { lerMarcador, TETO_DE_CARACTERES_DO_MARCADOR } from './marcador-de-issue.js'

/**
 * L4-T1b (achado 2 da auditoria de segurança): a identidade vem do CORPO DA
 * ISSUE — entrada não confiável, escrita por qualquer um com permissão de
 * comentar/editar no repositório do cliente — e ia direto para
 * `infra_incidents.identidade_estavel` sem limite nenhum. Teto de 200
 * caracteres corta qualquer tentativa de inflar a coluna. Reexportado por
 * compatibilidade — o teto real vive em `marcador-de-issue.ts` (R1).
 */
export const TETO_DE_CARACTERES_DA_IDENTIDADE = TETO_DE_CARACTERES_DO_MARCADOR

/**
 * Extrai a identidade estável do marcador HTML no corpo da issue. R1
 * (fix-up L4-T2): agora um fininho sobre `lerMarcador` (helper único de
 * marcador — `services/marcador-de-issue.ts`), comportamento idêntico ao de
 * antes (ver testes deste arquivo).
 */
export function identidadeDoMarcador(body: string | null | undefined): string | null {
  return lerMarcador(body, 'incident')
}

/** Uma issue de incidente aberta no GitHub, tal como a busca devolve. */
export interface IssueDeIncidenteLegada {
  number: number
  body: string | null
  createdAt: Date
}

export interface ReconciliarIncidentesLegadosDeps {
  projectId: string
  /** Issues abertas com label `gitorch:incident` (mesma busca de po-rails-mission.ts). */
  listarIssuesAbertas: () => Promise<IssueDeIncidenteLegada[]>
  /** Já existe uma linha de `infra_incidents` para esta identidade? */
  jaExisteLinha: (args: { projectId: string; identidadeEstavel: string }) => Promise<boolean>
  /** Número do PR da sessão que trabalhou esta issue, se já tiver um. */
  prDaSessaoDaIssue: (issueNumber: number) => Promise<number | null>
  /** Upsert por (projectId, identidadeEstavel) — cria a linha que faltava. */
  criarIncidente: (args: {
    projectId: string
    identidadeEstavel: string
    classe: string
    issueNumber: number
    firstSeenAt: Date
    prNumber: number | null
  }) => Promise<void>
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface ReconciliarIncidentesLegadosResultado {
  reconciliados: string[]
  ignorados: number
}

export async function reconciliarIncidentesLegados(
  deps: ReconciliarIncidentesLegadosDeps
): Promise<ReconciliarIncidentesLegadosResultado> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const res: ReconciliarIncidentesLegadosResultado = { reconciliados: [], ignorados: 0 }

  let issues: IssueDeIncidenteLegada[]
  try {
    issues = await deps.listarIssuesAbertas()
  } catch (err) {
    warn(`reconciliar-incidentes-legados: não li as issues abertas (${String(err).slice(0, 120)})`)
    return res
  }

  for (const issue of issues) {
    try {
      const identidade = identidadeDoMarcador(issue.body)
      if (!identidade) {
        res.ignorados += 1
        continue
      }

      const jaExiste = await deps.jaExisteLinha({
        projectId: deps.projectId,
        identidadeEstavel: identidade,
      })
      if (jaExiste) {
        res.ignorados += 1
        continue
      }

      const prNumber = await deps.prDaSessaoDaIssue(issue.number)
      await deps.criarIncidente({
        projectId: deps.projectId,
        identidadeEstavel: identidade,
        classe: 'ci-do-cliente',
        issueNumber: issue.number,
        firstSeenAt: issue.createdAt,
        prNumber,
      })
      res.reconciliados.push(identidade)
      info(`reconciliar-incidentes-legados: #${issue.number} (${identidade}) reconciliado`)
    } catch (err) {
      warn(
        `reconciliar-incidentes-legados: issue #${issue.number} falhou (${String(err).slice(0, 120)})`
      )
    }
  }
  return res
}
