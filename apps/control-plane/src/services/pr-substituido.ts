// Mesmo com a fila (fila-de-delegacao.ts) e a retomada no mesmo PR
// (retomar-pr-reprovado.ts) consertadas, a esteira ainda pode nascer um pull
// request NOVO para uma issue que já tem OUTRO pull request do dev aberto —
// uma retomada que falhou, uma corrida entre ciclos, ou qualquer caminho que
// ainda não foi pensado. Medido: issue #3884 do Jardim, pull requests #3907
// (31/08) e #3917 (02/09) da MESMA task, os dois abertos ao mesmo tempo.
//
// Fecha o PR ANTIGO, nunca o novo: o mais recente é o que tem a chance real
// de carregar o trabalho mais atualizado, e reabrir o antigo por engano seria
// pior do que deixar os dois abertos.
//
// A mesma lei de `vigia-do-pr.ts`: o produto julga toda entrega, mas só
// ADMINISTRA (aqui, fecha) o que ele mesmo encomendou — pull request de gente
// nunca é tocado, mesmo que esteja aberto e pareça duplicado.
//
// PURO NA DECISÃO — sem rede — e a ação (ler o PR, comentar, fechar) é
// injetada.

/** Prefixo do marcador oculto — usado tanto para escrever quanto para achar. */
const PREFIXO_DO_MARCADOR = '<!-- gitorch:pr-substituido:'

/** O marcador oculto que prova que ESTE pull request já foi fechado como substituído pelo `numeroDoNovo`. */
export function marcadorDePrSubstituido(numeroDoNovo: number): string {
  return `${PREFIXO_DO_MARCADOR}${numeroDoNovo} -->`
}

/** O que basta saber do PR antigo para decidir se ele precisa fechar. */
export interface SinaisDoPrAntigo {
  aberto: boolean
  /** Prova positiva de que é trabalho do dev (mesma régua de `ehPRDaAutomacao`, vigia-do-pr.ts). */
  ehDoDev: boolean
}

/**
 * Decide se ESTE pull request antigo precisa fechar como substituído.
 *
 * `null` (não deu para ler) nunca fecha — a mesma disciplina de
 * `decidirAcaoNoPrOrfao`: na dúvida, não age. PR de gente nunca fecha, mesmo
 * aberto: o produto só administra o que ele mesmo encomendou.
 */
export function deveFecharComoSubstituido(pr: SinaisDoPrAntigo | null): boolean {
  if (!pr) return false
  return pr.aberto && pr.ehDoDev
}

export interface DepsDeSubstituicaoDePr {
  /**
   * Outros números de pull request que sessões desta MESMA issue já
   * registraram (vivas ou fechadas), exceto o novo — de `dev_sessions`.
   */
  candidatosDaMesmaIssue: (args: {
    issueNumber: number
    numeroDoNovoPr: number
  }) => Promise<number[]>
  /** O que basta saber do PR antigo para decidir — `null` quando não deu para ler. */
  lerPr: (numeroDoPr: number) => Promise<SinaisDoPrAntigo | null>
  /** Comentários JÁ existentes no PR antigo — só para a idempotência. */
  comentariosDoPr: (numeroDoPr: number) => Promise<string[]>
  comentarEFechar: (args: { numeroDoPr: number; comentario: string }) => Promise<void>
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

/** O comentário PT-BR deixado no PR antigo antes de fechá-lo. */
function comentarioDeSubstituicao(numeroDoNovoPr: number): string {
  return (
    `Substituído por #${numeroDoNovoPr}.\n\n` +
    'A esteira abriu uma entrega nova para esta tarefa; fechando esta para não deixar duas ' +
    'entregas disputando a mesma issue.\n\n' +
    marcadorDePrSubstituido(numeroDoNovoPr)
  )
}

/**
 * Fecha, um a um, os pull requests do dev que ficaram para trás quando um PR
 * NOVO nasce para a MESMA issue.
 *
 * Falha num candidato nunca contamina os outros — mesma disciplina de
 * `vigiarPrsOrfaos`.
 */
export async function fecharPrsSubstituidos(
  args: { issueNumber: number; numeroDoNovoPr: number },
  deps: DepsDeSubstituicaoDePr
): Promise<number[]> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)

  const candidatos = await deps.candidatosDaMesmaIssue({
    issueNumber: args.issueNumber,
    numeroDoNovoPr: args.numeroDoNovoPr,
  })

  const fechados: number[] = []
  for (const numeroDoPr of candidatos) {
    try {
      const sinais = await deps.lerPr(numeroDoPr)
      if (!deveFecharComoSubstituido(sinais)) continue

      const comentarios = await deps.comentariosDoPr(numeroDoPr)
      const marcador = marcadorDePrSubstituido(args.numeroDoNovoPr)
      if (comentarios.some((c) => c.includes(marcador))) continue

      await deps.comentarEFechar({
        numeroDoPr,
        comentario: comentarioDeSubstituicao(args.numeroDoNovoPr),
      })
      fechados.push(numeroDoPr)
      info(`[pr-substituido] #${numeroDoPr} fechado — substituído por #${args.numeroDoNovoPr}`)
    } catch (err) {
      warn(`[pr-substituido] não deu para fechar #${numeroDoPr}: ${(err as Error).message}`)
    }
  }
  return fechados
}
