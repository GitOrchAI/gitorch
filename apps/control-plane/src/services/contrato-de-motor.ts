import { MODEL_DISCOVERERS } from './model-catalog.js'
import { QUOTA_READERS } from './quota-reader.js'

/**
 * Runtimes que o produto trata como MOTOR de IA — github mora na mesma
 * tabela (engine_connections), mas não é motor: não tem liveness, não tem
 * descobridor de catálogo nem leitor de cota (ver a lista deny em
 * EngineConnectionService.list, engine-connection.ts). Fonte única para o
 * boot e para os testes: um runtime novo entra aqui quando de fato tem os
 * dois lados do contrato.
 */
export const RUNTIMES_DE_MOTOR = ['antigravity', 'codex', 'claude'] as const

export interface ContratoQuebrado {
  runtime: string
  motivo: string
}

/**
 * Confere que todo runtime de motor tem TANTO um descobridor de catálogo
 * (MODEL_DISCOVERERS) quanto um leitor de cota (QUOTA_READERS) registrados.
 *
 * Sem isto, um motor sem um dos dois lados conecta normalmente, mas nunca
 * ganha modelo/cota nenhum — e a única forma de perceber era investigar o
 * banco vazio, sem NENHUMA pista de por quê. Puro (sem log, sem side effect):
 * quem chama decide o que fazer com as quebras.
 */
export function conferirContratoDeMotores(
  runtimes: readonly string[] = RUNTIMES_DE_MOTOR,
  modelDiscoverers: Record<string, unknown> = MODEL_DISCOVERERS,
  quotaReaders: Record<string, unknown> = QUOTA_READERS
): ContratoQuebrado[] {
  const quebras: ContratoQuebrado[] = []
  for (const runtime of runtimes) {
    const temDescobridor = Object.hasOwn(modelDiscoverers, runtime)
    const temLeitor = Object.hasOwn(quotaReaders, runtime)
    if (temDescobridor && temLeitor) continue
    if (!temDescobridor && !temLeitor) {
      quebras.push({
        runtime,
        motivo:
          'sem descobridor de catálogo (MODEL_DISCOVERERS) e sem leitor de cota (QUOTA_READERS)',
      })
    } else if (!temDescobridor) {
      quebras.push({ runtime, motivo: 'sem descobridor de catálogo (MODEL_DISCOVERERS)' })
    } else {
      quebras.push({ runtime, motivo: 'sem leitor de cota (QUOTA_READERS)' })
    }
  }
  return quebras
}

const motoresInutilizaveis = new Set<string>()

/**
 * Registra no log (erro, nunca silencioso) cada quebra de contrato e marca o
 * motor correspondente como inutilizável. Chamar UMA vez no boot.
 *
 * Nunca lança e nunca derruba o processo: um motor com contrato quebrado não
 * pode travar os outros nem impedir o boot — mas também não pode ficar
 * quieto: o achado de 26/08-30/08 foi exatamente essa classe de defeito
 * (cota/catálogo nulos, sem uma linha em lugar nenhum dizendo por quê).
 */
export function registrarContratoDeMotoresNoBoot(
  log: { error: (obj: unknown, msg?: string) => void } = console as unknown as {
    error: (obj: unknown, msg?: string) => void
  },
  runtimes: readonly string[] = RUNTIMES_DE_MOTOR,
  modelDiscoverers: Record<string, unknown> = MODEL_DISCOVERERS,
  quotaReaders: Record<string, unknown> = QUOTA_READERS
): ContratoQuebrado[] {
  const quebras = conferirContratoDeMotores(runtimes, modelDiscoverers, quotaReaders)
  for (const quebra of quebras) {
    motoresInutilizaveis.add(quebra.runtime)
    log.error(
      { runtime: quebra.runtime, motivo: quebra.motivo },
      `[contrato-de-motor] motor "${quebra.runtime}" inutilizável: ${quebra.motivo}`
    )
  }
  return quebras
}

/** Um motor marcado inutilizável no boot mais recente. */
export function motorEstaInutilizavel(runtime: string): boolean {
  return motoresInutilizaveis.has(runtime)
}

/** Só para teste: reseta o estado global entre casos. */
export function _resetMotoresInutilizaveisParaTeste(): void {
  motoresInutilizaveis.clear()
}
