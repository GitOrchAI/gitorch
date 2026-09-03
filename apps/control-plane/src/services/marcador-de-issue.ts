// R1 (fix-up L4-T2): helper ÚNICO de marcador HTML no corpo de uma issue.
// Antes deste arquivo, `services/proposta.ts` (marcadorDaProposta) e
// `services/reconciliar-incidentes-legados.ts` (identidadeDoMarcador)
// tinham cada um a própria regex para o MESMO padrão
// `<!-- gitorch:<tipo>:<id> -->` — dois lugares para o mesmo bug nascer.
// `marcador`/`lerMarcador` são a fonte única; os dois arquivos passam a
// reusar (comportamento idêntico ao de antes, ver seus próprios testes).

/**
 * L4-T1b (herdado de `reconciliar-incidentes-legados.ts`): o id vem do CORPO
 * DA ISSUE — entrada não confiável, escrita por qualquer um com permissão de
 * comentar/editar no repositório do cliente. Teto de 200 caracteres corta
 * qualquer tentativa de inflar a coluna que recebe o valor lido daqui.
 */
export const TETO_DE_CARACTERES_DO_MARCADOR = 200

/** Monta o comentário HTML do marcador: `<!-- gitorch:<tipo>:<id> -->`. */
export function marcador(tipo: string, id: string): string {
  return `<!-- gitorch:${tipo}:${id} -->`
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extrai o id do marcador do `tipo` pedido no corpo de uma issue. `trim`
 * primeiro (marcador só com espaços não deve virar string vazia
 * sobrevivente), depois teto de tamanho — nunca o contrário, senão um corte
 * no meio de espaços de borda poderia deixar sobra. `null` para corpo
 * vazio/ausente, marcador ausente, ou marcador vazio/só espaços.
 */
export function lerMarcador(body: string | null | undefined, tipo: string): string | null {
  if (!body) return null
  const re = new RegExp(`<!--\\s*gitorch:${escaparRegex(tipo)}:([^>]*?)\\s*-->`)
  const m = body.match(re)
  const bruto = m?.[1]
  if (bruto === undefined) return null
  const id = bruto.trim().slice(0, TETO_DE_CARACTERES_DO_MARCADOR)
  return id.length > 0 ? id : null
}
