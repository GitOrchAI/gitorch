// SENSOR de infra (os "olhos" do GitOrch): coleta erros REAIS do Actions /
// Dependabot do repositório do cliente e os devolve como ACHADOS TIPADOS.
//
// MUDANÇA DE CONTRATO (D54, 29/08): o sensor NÃO abre mais issue. Medido em
// produção — ele tratava toda run que já falhou uma vez como incidente novo,
// misturava cinco coisas diferentes (CI do cliente, config de Actions,
// Dependabot travado, encanamento do GitOrch, workflow morto) e abriu ~20
// issues duplicadas sem nenhuma análise confiável de RA/PO no meio.
//
// Agora: o sensor levanta o ACHADO; o RA entende a causa (ESTEIRA-T8); o PO
// escreve a issue padrão Shrimp ANTES de qualquer delegação. A coleta e a
// classificação vivem em `incidente-ci.ts` / `classificar-falha-de-infra.ts`.

import {
  coletarAchadosDeInfra,
  type AchadoDeInfra,
  type ColetarAchadosDeInfraOpts,
} from './incidente-ci.js'

/** Label das issues de incidente que o PO (T8) vai abrir a partir dos achados. */
export const INCIDENT_LABEL = 'gitorch:incident'

export interface AcharIncidentesDeInfraOptions {
  repository: string
  githubToken: string
  /** Contextos exigidos pela proteção do branch (se já conhecidos). */
  contextosQueTravamMerge?: string[]
  /** Teto de achados por varredura — proteção contra tempestade. */
  teto?: number
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}

export interface AcharIncidentesDeInfraResult {
  exitCode: number
  output: string
  stderr: string
  noOp: boolean
  achados: AchadoDeInfra[]
}

function resumoDosAchados(achados: AchadoDeInfra[]): string {
  if (achados.length === 0) return 'sensor de infra: nada quebrado.'
  const porClasse = new Map<string, number>()
  for (const a of achados) porClasse.set(a.classe, (porClasse.get(a.classe) ?? 0) + 1)
  const partes = [...porClasse.entries()].map(([classe, n]) => `${n} ${classe}`)
  return (
    `sensor de infra: ${achados.length} achado(s) — ${partes.join(', ')}. ` +
    `RA vai analisar a causa e o PO escreve a issue padrão (nenhuma issue aberta aqui).`
  )
}

/**
 * Varre a infra do repositório e devolve os achados tipados. Best-effort:
 * uma rota que falha vira `onWarn`, nunca joga.
 */
export async function acharIncidentesDeInfra(
  options: AcharIncidentesDeInfraOptions
): Promise<AcharIncidentesDeInfraResult> {
  const opts: ColetarAchadosDeInfraOpts = {
    repository: options.repository,
    githubToken: options.githubToken,
    ...(options.contextosQueTravamMerge
      ? { contextosQueTravamMerge: options.contextosQueTravamMerge }
      : {}),
    ...(options.teto !== undefined ? { teto: options.teto } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  }

  let achados: AchadoDeInfra[] = []
  try {
    achados = await coletarAchadosDeInfra(opts)
  } catch (err) {
    const msg = `sensor de infra: falhou (${String(err).slice(0, 150)}).`
    options.onWarn?.(msg)
    return { exitCode: 0, output: msg, stderr: '', noOp: true, achados: [] }
  }

  return {
    exitCode: 0,
    output: resumoDosAchados(achados),
    stderr: '',
    noOp: achados.length === 0,
    achados,
  }
}

/**
 * @deprecated Use `acharIncidentesDeInfra`. Mantido só para o call-site do
 * scheduler não quebrar durante a transição (ESTEIRA-T7→T8). NUNCA cria
 * issue — `created` é sempre `[]`.
 */
export async function runIncidentSensor(options: {
  repository: string
  githubToken: string
  cap?: number
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}): Promise<AcharIncidentesDeInfraResult & { created: number[] }> {
  const r = await acharIncidentesDeInfra({
    repository: options.repository,
    githubToken: options.githubToken,
    ...(options.cap !== undefined ? { teto: options.cap } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  })
  return { ...r, created: [] }
}
