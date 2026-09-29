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
  /** Issue #877 item 5: backfill do grafo de vínculos para itens que ainda
   *  não têm (repoItemVinculos ausente) — best-effort, com teto por ciclo
   *  (a cota da installation do GitHub estourou em produção com a coleta
   *  antiga, 5.969 respostas 403 em 24h — ver grafo-de-vinculos.ts).
   *  Ausente = varredura não faz backfill (comportamento de hoje).
   *
   *  `aplicar` devolve `true` quando REALMENTE disparou a coleta (o item não
   *  tinha grafo ainda, ou o grafo está velho o bastante pra justificar
   *  recoleta) e `false` quando só constatou que o item já está em dia e
   *  pulou. Bug real em produção (commit 4dfb2f86, 29/09/2026): o teto era
   *  gasto em TODO item do lote, inclusive os já cobertos — os 5 slots iam
   *  sempre pros itens mais recentes (já tinham grafo de ciclos anteriores),
   *  e itens antigos sem grafo (ex.: PR #583, issue #877) nunca eram
   *  alcançados. Só contar quem `aplicar` de fato coletou resolve isso. */
  backfillGrafo?: {
    aplicar: (args: { tipo: TipoDoItem; numero: number }) => Promise<boolean>
    teto: number
  }
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
  // Issue #877 item 5: contador COMPARTILHADO entre os dois laços (PRs e
  // issues) — o teto é por CICLO da varredura inteira, não por laço. Se o
  // ciclo termina antes de cobrir tudo, é esperado: o próximo ciclo (30 min)
  // continua de onde faltou (não há registro de "onde parei" — o backfill só
  // pula quem já tem `vinculos`, então repassar não duplica trabalho útil).
  let tentativasDeBackfill = 0

  const tentarBackfill = async (tipo: TipoDoItem, numero: number): Promise<void> => {
    if (!deps.backfillGrafo) return
    if (tentativasDeBackfill >= deps.backfillGrafo.teto) return
    try {
      // Só incrementa o teto quando `aplicar` de fato disparou a coleta —
      // item que já estava em dia (retornou false) é pulado sem gastar slot,
      // deixando o teto sobrar pra quem realmente precisa (issue #877).
      const coletou = await deps.backfillGrafo.aplicar({ tipo, numero })
      if (coletou) tentativasDeBackfill += 1
    } catch (err) {
      // Erro aconteceu DEPOIS de decidir coletar (aplicar só lança depois de
      // já ter passado da checagem "já tem grafo?") — conta como tentativa
      // real pra não virar retry-storm no mesmo item dentro do ciclo.
      tentativasDeBackfill += 1
      deps.onWarn?.(
        `varredura-do-retrato: backfill do grafo de vínculos falhou para ${tipo} #${numero} (${deps.repo}): ${err}`
      )
    }
  }

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
      await tentarBackfill('pr', pr.number)
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
      await tentarBackfill('issue', issue.number)
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
