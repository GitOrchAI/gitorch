// A leitura de "esta entrega JÁ tem parecer nosso no commit de agora?".
//
// Ela nasceu dentro do laço de descoberta do julgamento (qa-rails-mission.ts)
// e vivia só lá. Agora o acordar do SM precisa da MESMA leitura para saber
// quais entregas ainda estão sem parecer — e uma segunda cópia da regra seria
// a receita para as duas divergirem: o SM chamaria o julgamento para uma
// entrega que o julgamento vai pular, e a fila nunca esvaziaria.
//
// Por isso a regra mora aqui, num lugar só, e os dois a importam.

/**
 * Marca invisível que TODA review postada pelo produto carrega. É o que
 * separa o parecer do gitorch do comentário de um humano no mesmo pull
 * request.
 */
export const MARCA_DO_PARECER = '<!-- gitorch:qa -->'

/**
 * Trecho EXATO que só o corpo de uma review de APROVAÇÃO contém (ver a
 * montagem do corpo em qa-rails-mission.ts, ramo `effectiveVerdict ===
 * 'approve'`). Sem ele, entre duas reviews nossas marcadas no mesmo commit
 * uma aprovação e uma reprovação ficam indistinguíveis.
 */
export const MARCA_DE_APROVACAO = 'verdict: APPROVE'

export interface ReviewDoGithub {
  body?: string
  commit_id?: string
}

/**
 * Acha o ÚLTIMO parecer nosso postado contra `headSha`, ou `undefined` quando
 * não há nenhum.
 *
 * A varredura é de trás para frente de propósito: o GitHub devolve as reviews
 * da mais ANTIGA para a mais NOVA, e mais de um parecer nosso pode existir no
 * MESMO commit (uma aprovação e, depois, um "pedir mudanças" quando a
 * verificação vira vermelha sem push novo). Pegar a primeira devolveria para
 * sempre a aprovação original — o beco sem saída já documentado em
 * qa-rails-mission.ts.
 *
 * `headSha` ausente (resposta do GitHub sem `head`) faz a comparação de commit
 * ser ignorada: qualquer parecer marcado conta. É o lado seguro — na dúvida,
 * "já tem parecer", que só causa um julgamento a menos, nunca uma opinião
 * duplicada no repositório do cliente.
 */
export function acharParecerNesteHead(
  reviews: readonly ReviewDoGithub[] | undefined,
  headSha: string | undefined
): ReviewDoGithub | undefined {
  if (!Array.isArray(reviews)) return undefined
  for (let i = reviews.length - 1; i >= 0; i--) {
    const candidata = reviews[i]
    if (!candidata) continue
    if (!(candidata.body ?? '').includes(MARCA_DO_PARECER)) continue
    if (headSha && candidata.commit_id !== headSha) continue
    return candidata
  }
  return undefined
}

/** O parecer encontrado é uma aprovação? */
export function ehAprovacao(review: ReviewDoGithub | undefined): boolean {
  return Boolean(review && (review.body ?? '').includes(MARCA_DE_APROVACAO))
}
