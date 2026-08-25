/**
 * O desejo já foi analisado pelo analista de requisitos?
 *
 * O RA tem DOIS trabalhos, e eu tinha confundido os dois. Pelo webhook, quando
 * um desejo novo chega, ele analisa aquele desejo. Pela agenda, duas vezes por
 * dia, ele é EXPLORADOR do projeto: mapeia as áreas que o sistema toca — o que
 * existe hoje no frontend, no backend, no banco, nas integrações — com os
 * caminhos reais dos arquivos, e escreve jornadas pensando como dono do
 * produto. O próprio código diz isso: "sem wish aberta, segue como scout geral
 * do projeto".
 *
 * O desejo é ÂNCORA da exploração, não a tarefa dela.
 *
 * O defeito: pela agenda ele ancorava SEMPRE no desejo aberto mais recente,
 * mesmo já analisado. Duas vezes por dia refazia a mesma análise em vez de
 * aprender mais do projeto — e é justamente o explorador quem deveria estar
 * alimentando a memória que os outros agentes leem.
 *
 * A marca vive no CORPO da issue, como o PO já faz com as issues dele. Corpo de
 * issue sobrevive a reinício, a redeploy e a troca de banco; marca em memória
 * não sobreviveria nem ao próximo restart.
 */

/** A marca que o RA deixa no desejo depois de analisá-lo. */
export const MARCA_DE_ANALISE_DO_RA = '<!-- gitorch:ra:analisado -->'

export interface DesejoParaAnalisar {
  numero: number
  corpo?: string | null | undefined
  /** Quando o desejo foi editado pela última vez, como o GitHub informa. */
  atualizadoEm?: string | null | undefined
}

export type DecisaoDoRa =
  { acao: 'ancorar-no-desejo'; motivo: string } | { acao: 'explorar-o-projeto'; motivo: string }

/**
 * Ancorar neste desejo, ou explorar o projeto?
 *
 * `pelaAgenda` separa os dois trabalhos: o webhook SEMPRE ancora, porque ele só
 * dispara quando um desejo novo chega e é exatamente esse desejo que precisa de
 * análise. A agenda é que precisa escolher.
 */
export function decidirTrabalhoDoRa(args: {
  desejo: DesejoParaAnalisar | null | undefined
  pelaAgenda: boolean
  /** Quando a análise anterior foi feita, se houver registro dela. */
  analisadoEm?: Date | null | undefined
}): DecisaoDoRa {
  if (!args.desejo) {
    return { acao: 'explorar-o-projeto', motivo: 'não há desejo aberto' }
  }

  if (!args.pelaAgenda) {
    return { acao: 'ancorar-no-desejo', motivo: 'desejo novo chegou agora' }
  }

  const jaAnalisado = (args.desejo.corpo ?? '').includes(MARCA_DE_ANALISE_DO_RA)
  if (!jaAnalisado) {
    return { acao: 'ancorar-no-desejo', motivo: 'este desejo ainda não foi analisado' }
  }

  // Desejo EDITADO depois da análise merece análise nova: o dono mudou o que
  // quer, e a análise anterior é sobre outra coisa. Sem isto, uma correção do
  // dono no texto do desejo seria ignorada para sempre.
  if (args.analisadoEm && args.desejo.atualizadoEm) {
    const editado = new Date(args.desejo.atualizadoEm).getTime()
    if (Number.isFinite(editado) && editado > args.analisadoEm.getTime()) {
      return { acao: 'ancorar-no-desejo', motivo: 'o desejo foi editado depois da análise' }
    }
  }

  return {
    acao: 'explorar-o-projeto',
    motivo: 'o desejo aberto já foi analisado; a agenda é para explorar o projeto',
  }
}

/**
 * O corpo do desejo com a marca da análise.
 *
 * Idempotente: marcar duas vezes não duplica a marca, e o corpo do dono nunca
 * é reescrito — a marca entra no fim, invisível no GitHub por ser comentário.
 */
export function marcarComoAnalisado(corpo: string | null | undefined): string {
  const original = corpo ?? ''
  if (original.includes(MARCA_DE_ANALISE_DO_RA)) return original
  return original === '' ? MARCA_DE_ANALISE_DO_RA : `${original}\n\n${MARCA_DE_ANALISE_DO_RA}`
}
