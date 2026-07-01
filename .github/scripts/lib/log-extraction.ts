/**
 * Extração inteligente de trechos relevantes de logs de CI.
 *
 * Logs de CI costumam ter muito ruído no início (boot de serviços como Postgres, setup de
 * ambiente) antes do erro real aparecer. Um corte ingênuo (`substring(0, N)`) frequentemente
 * descarta o erro de verdade quando ele surge tarde no log, fazendo a LLM "chutar" a causa raiz
 * a partir de outro contexto (ex.: a issue original) em vez do log real.
 *
 * Estratégia: priorizar linhas com `##[error]` (anotação nativa do GitHub Actions) + uma janela
 * de contexto ao redor de cada uma, mais o final do log (onde o processo normalmente encerra).
 */

interface Window {
  start: number
  end: number // exclusivo
}

function mergeWindows(windows: Window[]): Window[] {
  if (windows.length === 0) return []
  const sorted = [...windows].sort((a, b) => a.start - b.start)
  const merged: Window[] = [sorted[0]!]
  for (const w of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (w.start <= last.end) {
      last.end = Math.max(last.end, w.end)
    } else {
      merged.push(w)
    }
  }
  return merged
}

export function extractRelevantLogSections(logText: string, maxChars = 9000): string {
  const lines = logText.split('\n')
  if (lines.length === 0) return ''

  const errorIndexes = lines
    .map((line, i) => (line.includes('##[error]') ? i : -1))
    .filter((i) => i >= 0)

  const windows: Window[] = errorIndexes.map((i) => ({
    start: Math.max(0, i - 5),
    end: Math.min(lines.length, i + 16),
  }))

  // Sempre inclui o final do log (últimas ~40 linhas) — é onde o processo tipicamente encerra.
  windows.push({ start: Math.max(0, lines.length - 40), end: lines.length })

  const merged = mergeWindows(windows)
  const sections = merged.map((w) => lines.slice(w.start, w.end).join('\n'))
  let combined = sections.join('\n...\n')

  if (combined.length > maxChars) {
    // Prefere o final do conteúdo já curado (mais perto do erro/saída) em vez do início.
    combined = '...[truncado]...\n' + combined.slice(-maxChars)
  }

  // Fallback: nenhuma anotação de erro encontrada — usa o final do log bruto (não o início),
  // pois é ali que a falha normalmente aparece.
  return combined || logText.slice(-maxChars)
}
