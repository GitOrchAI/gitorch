// A varredura de conferência: a cada 30 min por projeto, pega o que o
// webhook perdeu (entrega que falhou, aviso que o GitHub não reenviou,
// projeto conectado antes de existir webhook). Mesmo papel que
// `vigiarPrsOrfaos` (vigia-do-pr.ts) já cumpre para pull requests órfãos,
// mas aqui o alvo é a FICHA (Fase 0-1), não a decisão de agir.

import {
  estadoDoPrAPartirDoPayload,
  estadoDaIssueAPartirDoPayload,
} from '../routes/github-webhook.js'
import type { EstadoDoItem, TipoDoItem } from './ficha-do-item.js'

/** Cadência da varredura de retrato — separada da de `vigiarPrsOrfaos` (6h): a
 *  ficha precisa ficar em dia bem mais rápido que a decisão de agir sobre um
 *  pull request órfão. */
export const CADENCIA_DO_RETRATO_MS = 30 * 60_000

export const MAX_PAGINAS_DA_VARREDURA = 20

export interface VarreduraDoRetratoDeps {
  repo: string
  ghGet: (caminho: string) => Promise<unknown>
  atualizarFicha: (args: {
    tipo: TipoDoItem
    numero: number
    estado: EstadoDoItem
  }) => Promise<void>
  onWarn?: (m: string) => void
}

interface PrCru {
  number: number
  state?: string
  draft?: boolean
  mergeable?: boolean | null
  head?: { sha?: string }
  changed_files?: number
}

interface IssueCru {
  number: number
  state?: string
  pull_request?: unknown
}

export async function varrerRetratoDoProjeto(
  deps: VarreduraDoRetratoDeps
): Promise<{ prs: number; issues: number; alertas: number }> {
  let prs = 0
  let issues = 0

  for (let pagina = 1; pagina <= MAX_PAGINAS_DA_VARREDURA; pagina += 1) {
    const lote = (await deps.ghGet(
      `/repos/${deps.repo}/pulls?state=open&per_page=100&page=${pagina}`
    )) as PrCru[]
    for (const pr of lote) {
      await deps.atualizarFicha({
        tipo: 'pr',
        numero: pr.number,
        estado: estadoDoPrAPartirDoPayload({ pull_request: pr }),
      })
      prs += 1
    }
    if (lote.length < 100) break
    if (pagina === MAX_PAGINAS_DA_VARREDURA) {
      deps.onWarn?.(
        `varredura-do-retrato: ${deps.repo} tem mais PRs do que a varredura cobre nesta passada`
      )
    }
  }

  for (let pagina = 1; pagina <= MAX_PAGINAS_DA_VARREDURA; pagina += 1) {
    const lote = (await deps.ghGet(
      `/repos/${deps.repo}/issues?state=open&per_page=100&page=${pagina}`
    )) as IssueCru[]
    for (const issue of lote) {
      // A rota /issues do GitHub devolve pull requests JUNTO (todo PR também
      // é uma issue lá dentro) — `pull_request` presente é a marca de que
      // esta linha já foi contada na varredura de PRs acima.
      if (issue.pull_request) continue
      await deps.atualizarFicha({
        tipo: 'issue',
        numero: issue.number,
        estado: estadoDaIssueAPartirDoPayload({ issue }),
      })
      issues += 1
    }
    if (lote.length < 100) break
    if (pagina === MAX_PAGINAS_DA_VARREDURA) {
      deps.onWarn?.(
        `varredura-do-retrato: ${deps.repo} tem mais issues do que a varredura cobre nesta passada`
      )
    }
  }

  // Alertas de segurança: a Fase 5.2 estende esta função para gravar a ficha
  // de cada alerta usando `coletarDividaDeSeguranca` (security-debt-collector.ts)
  // — não duplicado aqui porque aquele serviço exige a credencial do CLIENTE
  // (403 na do produto), diferente de `ghGet` acima, e a Fase 5 é quem decide
  // como as duas credenciais convivem nesta mesma varredura.
  return { prs, issues, alertas: 0 }
}
