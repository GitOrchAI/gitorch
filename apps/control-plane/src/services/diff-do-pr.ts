// Lê o diff do PR inteiro, virando a página até o fim.
//
// Antes: uma única página de até 50 arquivos, cada trecho cortado em 2.000
// caracteres e o todo em 20.000 — sem virar página e sem dizer que cortou. Em
// PR grande o julgamento acontecia sobre um pedaço, e nada na saída revelava
// isso. Agora, quando não cabe, o corte é DECLARADO: quem julga precisa poder
// dizer "não consigo verificar" em vez de aprovar por omissão.

/** Teto do que cabe no contexto do motor sem estourar o passo do formulário. */
export const LIMITE_DE_CARACTERES = 120_000

/** Teto de páginas, para PR patológico não girar para sempre. */
export const MAX_PAGINAS = 20

export interface ArquivoDoPr {
  filename: string
  patch?: string
}

export interface DiffDoPr {
  diff: string
  arquivos: number
  /** O diff não coube por inteiro. Quem julga TEM de considerar isto. */
  truncado: boolean
}

export async function lerDiffDoPr(deps: {
  /** Página 1-indexada de arquivos do PR. Devolve vazio quando acabou. */
  buscarPagina: (pagina: number) => Promise<ArquivoDoPr[]>
}): Promise<DiffDoPr> {
  const pedacos: string[] = []
  let tamanho = 0
  let arquivos = 0
  let truncado = false

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const lote = await deps.buscarPagina(pagina)
    if (!Array.isArray(lote) || lote.length === 0) break

    for (const arquivo of lote) {
      arquivos += 1
      const corpo = arquivo.patch ?? '(sem trecho de mudança legível)'
      const bloco = `--- ${arquivo.filename}\n${corpo}`
      if (tamanho + bloco.length > LIMITE_DE_CARACTERES) {
        truncado = true
        break
      }
      pedacos.push(bloco)
      tamanho += bloco.length + 1
    }

    if (truncado) break
  }

  return { diff: pedacos.join('\n'), arquivos, truncado }
}
