// "Em construção" (Fase 3.9): rascunho, ou commit recente demais para julgar
// — dentro da janela configurada (Tarefa 0.2), o motor do próximo passo só
// acompanha, nunca julga nem mescla.

/** Teto: acima disto, mesmo commit "recente" não é mais tratado como
 *  construção em andamento — evita `null` de `ultimoCommitEm` parecer
 *  "construção infinita". */
const TETO_DE_HORAS_CONSIDERADAS = 48

export function horasEmConstrucao(args: {
  rascunho: boolean
  ultimoCommitEm: string | null
  agora: Date
}): number | null {
  if (args.rascunho) return 0
  if (!args.ultimoCommitEm) return null
  const commit = new Date(args.ultimoCommitEm)
  if (!Number.isFinite(commit.getTime())) return null
  const horas = (args.agora.getTime() - commit.getTime()) / (60 * 60 * 1000)
  if (horas < 0 || horas > TETO_DE_HORAS_CONSIDERADAS) return null
  return Math.floor(horas)
}
