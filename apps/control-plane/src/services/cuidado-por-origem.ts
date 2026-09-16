// Quem cuida de cada origem de pedido, por projeto (Fase 0.2 do plano do
// repositório inteiro). Guardado em Project.runtimeConfig.cuidaPorOrigem —
// mesmo padrão de runtimeConfig.publicacao (como-o-projeto-publica.ts) e
// runtimeConfig.board (board-status.ts): JSON aditivo, sem migração de coluna.

export const ORIGENS = ['jules', 'assistente', 'pessoa', 'dependabot'] as const
export type OrigemDoItem = (typeof ORIGENS)[number]

export const POLITICAS_DE_CUIDADO = ['sim', 'nao', 'perguntar'] as const
export type PoliticaDeCuidado = (typeof POLITICAS_DE_CUIDADO)[number]

export type CuidaPorOrigem = Record<OrigemDoItem, PoliticaDeCuidado>

/**
 * O padrão de quem nunca configurou. Decisão do dono (plano aprovado, Fase 0):
 * Jules cuida sozinho, Dependabot cuida sozinho, assistente de código e pessoa
 * ficam em "perguntar" — a mesma premissa de "pedir permissão a mais" que já
 * rege `NIVEL_PADRAO` em packages/cadence/src/autonomia.ts.
 *
 * `ehPlanoDoDono` existe para o dia em que o produto distinguir a própria
 * instância das dos clientes (mesmo gancho que `autonomia` usa hoje: projeto
 * sem escolha nasce no nível mais restrito, e só se abre por decisão
 * explícita) — hoje o valor não muda o resultado; ficar aqui como parâmetro
 * evita reabrir a assinatura da função quando essa distinção existir de
 * verdade, em vez de inventar um comportamento que ninguém pediu ainda.
 */
export const PADRAO_DE_CUIDADO: CuidaPorOrigem = {
  jules: 'sim',
  assistente: 'perguntar',
  pessoa: 'perguntar',
  dependabot: 'sim',
}

export const JANELA_EM_CONSTRUCAO_PADRAO_HORAS = 2

interface ConfiguracaoComCuidado {
  cuidaPorOrigem?: Partial<Record<string, unknown>>
  janelaEmConstrucaoHoras?: unknown
}

/** O que este projeto configurou, com o padrão para o que faltar ou for lixo. */
export function lerCuidaPorOrigem(runtimeConfig: unknown, _ehPlanoDoDono: boolean): CuidaPorOrigem {
  const bruto = (runtimeConfig as ConfiguracaoComCuidado | null)?.cuidaPorOrigem
  const saida = { ...PADRAO_DE_CUIDADO }
  if (!bruto || typeof bruto !== 'object') return saida
  for (const origem of ORIGENS) {
    const valor = bruto[origem]
    if (typeof valor === 'string' && POLITICAS_DE_CUIDADO.includes(valor as PoliticaDeCuidado)) {
      saida[origem] = valor as PoliticaDeCuidado
    }
  }
  return saida
}

/** Quantas horas um item "em construção" (rascunho ou commit recente) fica só sendo acompanhado. */
export function lerJanelaEmConstrucaoHoras(runtimeConfig: unknown): number {
  const bruto = (runtimeConfig as ConfiguracaoComCuidado | null)?.janelaEmConstrucaoHoras
  if (typeof bruto !== 'number' || !Number.isFinite(bruto) || bruto <= 0) {
    return JANELA_EM_CONSTRUCAO_PADRAO_HORAS
  }
  return bruto
}
