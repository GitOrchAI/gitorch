/**
 * O conflito de merge é trabalho do dev, não do dono.
 *
 * Medido em 25/08, no aviso que chegou ao Telegram do dono: "o merge do PR
 * #3762 falhou 3 vezes seguidas... Pull Request has merge conflicts... é
 * preciso ação humana (ex.: resolver o conflito) antes de uma nova tentativa."
 *
 * O produto parava e chamava o dono. Mas resolver conflito é exatamente o que o
 * dev assíncrono sabe fazer: ele tem o repositório, o contexto da tarefa e uma
 * sessão aberta. Chamar o dono para isso é devolver a ele o trabalho que o
 * produto existe para tirar das costas dele.
 *
 * Nem toda falha de merge é assim, e por isso a distinção vive aqui: uma
 * proteção de branch que exige revisão humana, uma permissão que falta, um
 * check obrigatório vermelho — nada disso o dev resolve, e insistir com ele
 * seria empurrar trabalho impossível enquanto o dono fica sem saber.
 */

export type QuemResolve =
  /** O dev refaz a base e resolve — é trabalho dele. */
  | { quem: 'dev'; pedido: string }
  /** Ninguém do produto resolve: o dono precisa saber. */
  | { quem: 'dono'; motivo: string }

/**
 * O GitHub recusa merge com 405 em várias situações. Só uma delas é conflito.
 *
 * A mensagem é o sinal, e não o código: `Pull Request has merge conflicts` é o
 * texto que ele devolve para este caso. Casar pelo código sozinho trataria
 * proteção de branch e check vermelho como se fossem conflito.
 */
export function ehConflitoDeMerge(motivo: string | null | undefined): boolean {
  return /merge conflict/i.test(motivo ?? '')
}

export interface SituacaoDoMerge {
  motivo: string | null | undefined
  /** Há sessão viva do dev para receber o pedido? */
  temSessaoViva: boolean
  /** Quantas vezes já pedimos rebase para ESTE mesmo commit. */
  pedidosDeRebase: number
  numeroDoPr: number
}

/**
 * Teto de pedidos de rebase por commit.
 *
 * Dois, e não mais: se o dev não resolveu na segunda, ou o conflito é maior do
 * que ele alcança, ou há algo no repositório que ele não entende. Insistir a
 * terceira vez queima cota e adia o momento em que o dono descobre — que é
 * justamente o que não pode acontecer.
 */
export const MAX_PEDIDOS_DE_REBASE = 2

/** Quem resolve este merge que não passou? */
export function decidirQuemResolve(situacao: SituacaoDoMerge): QuemResolve {
  if (!ehConflitoDeMerge(situacao.motivo)) {
    return {
      quem: 'dono',
      motivo: 'a recusa do merge não é conflito de código, e o dev não tem como resolver',
    }
  }

  // Sessão fechada: não há a quem pedir. O aviso ao dono é o certo, e não um
  // recuo — pedir para o vazio deixaria a entrega parada em silêncio.
  if (!situacao.temSessaoViva) {
    return {
      quem: 'dono',
      motivo: 'há conflito, mas a sessão do dev já foi encerrada e não há a quem pedir',
    }
  }

  if (situacao.pedidosDeRebase >= MAX_PEDIDOS_DE_REBASE) {
    return {
      quem: 'dono',
      motivo: `o dev foi chamado ${situacao.pedidosDeRebase} vezes para resolver o conflito e ele continua de pé`,
    }
  }

  return { quem: 'dev', pedido: pedidoDeRebase(situacao.numeroDoPr) }
}

/**
 * O texto do pedido de rebase — extraído de `decidirQuemResolve` para ser
 * REAPROVEITADO, não recopiado.
 *
 * Quem mais precisa dele: o vigia do pull request órfão (`vigia-do-pr.ts`).
 * Lá a sessão do dev já morreu, então `decidirQuemResolve` responde 'dono' —
 * corretamente, porque não há a quem pedir NAQUELE momento. O vigia muda a
 * premissa: ele ABRE uma sessão nova para o mesmo trabalho, e aí passa a haver
 * a quem pedir. O que ele não pode fazer é reescrever a frase por conta
 * própria: duas versões do mesmo pedido divergiriam, e o dev receberia
 * instruções diferentes para o mesmo problema dependendo de qual caminho o
 * alcançou.
 */
export function pedidoDeRebase(numeroDoPr: number): string {
  return [
    `O pull request #${numeroDoPr} não pôde ser mesclado: ele tem conflito com a`,
    'branch principal, que andou desde que você começou.',
    '',
    'Traga a base para o seu ramo (rebase ou merge da principal), resolva os conflitos',
    'preservando o que a sua entrega faz, e empurre. Não mude nada fora do escopo da',
    'tarefa enquanto faz isso.',
  ].join('\n')
}
