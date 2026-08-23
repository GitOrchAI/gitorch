// Sobreposição dos tetos de plano por AMBIENTE.
//
// POR QUE ISTO EXISTE, medido em 23/08/2026 durante a prova ponta a ponta.
//
// O desejo do dono virou issue, o webhook chegou, o produto reconheceu e
// acordou o analista — e ele morreu em "Orçamento do plano pro atingido
// (90/90); pulando". São DOIS tetos, e isso não estava óbvio para ninguém:
//
//   - o da INSTÂNCIA (`GITORCH_MAX_MISSIONS_PER_DAY`), que protege a máquina
//   - o do PLANO (tabela `plans`), que é o PRODUTO vendido ao cliente
//
// Eu tinha liberado o primeiro e não sabia do segundo. O dono subiu o segundo
// à mão no banco — e ali estava a armadilha: `seed.ts --plans-only` roda a
// CADA deploy, por decisão deliberada e documentada, e faz upsert dos quatro
// planos. O próximo deploy apagaria a mudança dele em silêncio, e a esteira
// voltaria a travar sem ninguém entender por quê.
//
// O QUE ESTE MÓDULO NÃO FAZ: mudar os números do produto. Os limites dos
// planos são o que se vende, e alterá-los no seed mudaria a oferta para todo
// cliente. A sobreposição é de AMBIENTE — vale onde a variável existe, e em
// lugar nenhum além disso.

export interface LimitesDoPlano {
  maxMissionsPerDay: number
  maxConcurrentMissions: number
}

/**
 * Lê a sobreposição de um plano no ambiente, ou `null` quando não há.
 *
 * Formato: `GITORCH_PLANO_<ID>_MISSOES_POR_DIA` e
 * `GITORCH_PLANO_<ID>_CONCORRENTES`. Cada uma é opcional e independente: dá
 * para subir só o teto do dia sem mexer na concorrência.
 *
 * Valor inválido é IGNORADO com aviso, nunca aplicado. `Number('')` é zero e
 * `Number('abc')` é NaN — sem esta guarda, uma variável vazia zeraria o teto
 * do plano e calaria a esteira inteira, que é o oposto do que ela vem fazer.
 * É o mesmo erro que já custou caro na cadência da reconciliação.
 */
export function tetoDoAmbiente(
  planoId: string,
  padrao: LimitesDoPlano,
  ambiente: NodeJS.ProcessEnv = process.env,
  onWarn: (m: string) => void = console.warn
): LimitesDoPlano {
  const ler = (sufixo: string, atual: number): number => {
    const chave = `GITORCH_PLANO_${planoId.toUpperCase()}_${sufixo}`
    const bruto = ambiente[chave]
    if (bruto === undefined) return atual
    const lido = Number(bruto)
    if (!Number.isFinite(lido) || lido <= 0) {
      onWarn(`[seed] ${chave} inválido ('${bruto}'); mantendo o padrão do plano (${atual})`)
      return atual
    }
    return lido
  }

  return {
    maxMissionsPerDay: ler('MISSOES_POR_DIA', padrao.maxMissionsPerDay),
    maxConcurrentMissions: ler('CONCORRENTES', padrao.maxConcurrentMissions),
  }
}
