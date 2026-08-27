import type { QuotaReading } from './quota-reader.js'

/**
 * A cota lida, ou o motivo de não ter sido — nunca um nulo mudo.
 *
 * MEDIDO EM PRODUÇÃO em 26/08: as colunas de cota dos DOIS motores estavam
 * vazias (`quota_remaining`, `quota_total`, `session_percent_used`,
 * `week_percent_used` todas nulas) e, em `missions`, `quota_before`/
 * `quota_after` eram nulas em 100% das 340 missões de 24 horas. O catálogo de
 * modelos vinha cheio (codex 3, antigravity 14), então a descoberta funcionava
 * — quem devolvia nulo era a leitura de cota, e o `.catch(() => emptyQuota)`
 * engolia o motivo junto.
 *
 * O produto ficou sem saber quanto resta em nenhum motor: não avisa "está
 * acabando", não escolhe o motor com mais folga, não segura o gasto do cliente
 * no BYOK. Só aprende que a cota acabou quando a missão MORRE.
 *
 * E havia uma MENTIRA no dado, que é o pior: `quota_refreshed_at` era
 * carimbado do mesmo jeito quando a leitura falhava. A linha dizia "li a cota
 * às 20:26" tendo lido nada. Quem fosse investigar veria um carimbo recente e
 * concluiria que a coleta estava funcionando — foi exatamente o que quase
 * aconteceu.
 */

export interface CotaLida {
  leitura: QuotaReading
  /** `true` só quando algum número REAL veio. */
  temNumero: boolean
  /** Por que não veio, quando não veio. Nunca é `null` junto com `temNumero: false`. */
  motivo: string | null
}

const VAZIA: QuotaReading = { remaining: null, total: null }

/** Algum número real veio nesta leitura? */
export function temNumeroDeCota(leitura: QuotaReading): boolean {
  return (
    leitura.remaining !== null ||
    leitura.total !== null ||
    typeof leitura.sessionPercentUsed === 'number' ||
    typeof leitura.weekPercentUsed === 'number'
  )
}

/**
 * Lê a cota de um motor sem engolir o motivo do fracasso.
 *
 * Continua best-effort — falhar a leitura de cota NUNCA pode derrubar a
 * descoberta de modelos nem a conexão. O que muda é que o silêncio acabou:
 * ou vem número, ou vem a razão de não ter vindo.
 */
export async function lerCotaDoMotor(args: {
  runtime: string
  ler: ((home: string) => Promise<QuotaReading>) | undefined
  home: string
}): Promise<CotaLida> {
  if (!args.ler) {
    return {
      leitura: VAZIA,
      temNumero: false,
      motivo: `não há leitor de cota para ${args.runtime}`,
    }
  }
  let leitura: QuotaReading
  try {
    leitura = await args.ler(args.home)
  } catch (err) {
    return {
      leitura: VAZIA,
      temNumero: false,
      motivo: `a leitura de cota de ${args.runtime} falhou: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!temNumeroDeCota(leitura)) {
    return {
      leitura,
      temNumero: false,
      motivo: `o leitor de cota de ${args.runtime} rodou e não devolveu número nenhum`,
    }
  }
  return { leitura, temNumero: true, motivo: null }
}

/**
 * O carimbo de "li a cota agora" — presente SÓ quando de fato houve leitura.
 *
 * É a correção da mentira: carimbar mesmo sem número fazia a linha do banco
 * afirmar uma coleta que nunca aconteceu, e mandava quem investigasse para o
 * lado errado.
 */
export function carimboDaLeitura(cota: CotaLida, agora: Date): { quotaRefreshedAt?: Date } {
  return cota.temNumero ? { quotaRefreshedAt: agora } : {}
}
