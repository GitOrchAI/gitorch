/**
 * A ordem em que o QA olha os pull requests abertos.
 *
 * MEDIDO: os PRs #3758 e #3747 esperavam parecer desde 21 e 15/08 — dias — com
 * o julgamento funcionando normalmente o tempo todo. Não era fome absoluta: o
 * QA ALCANÇA os antigos (o #3768, preso desde 23/08, foi aprovado e mesclado
 * sozinho às 00:00:51 de 25/08). Era LENTIDÃO por ordenação.
 *
 * A busca listava do mais NOVO para o mais antigo e o laço parava no primeiro
 * que precisava julgar. Com pull request novo entrando o tempo todo, todo
 * recém-chegado passava na frente de quem esperava há dias — e o antigo só era
 * alcançado numa janela em que nenhum novo aparecesse.
 *
 * INTERCALAR AS PONTAS NÃO RESOLVE, e vale registrar porque foi a primeira
 * tentativa: se o mais novo é sempre o primeiro da fila e o laço para no
 * primeiro que precisa de parecer, um recém-chegado a cada acordada mantém o
 * antigo em segundo lugar para sempre. Segundo lugar eterno é o mesmo que
 * nunca.
 *
 * O que resolve é ALTERNAR A PONTA a cada acordada. Numa o QA começa pelos
 * mais novos, na seguinte pelos mais antigos. Assim o recém-chegado espera no
 * máximo uma acordada pelo primeiro parecer, e o antigo espera no máximo uma
 * acordada pela vez dele — nenhum dos dois depende de uma janela de sorte.
 */
export function ordemDoJulgamento<T>(
  prsDoMaisAntigoAoMaisNovo: readonly T[],
  /**
   * Nesta acordada, começar pelos mais antigos?
   *
   * Quem chama alterna a cada acordada — é o que impede que qualquer uma das
   * pontas fique em segundo lugar para sempre.
   */
  comecarPeloMaisAntigo: boolean
): T[] {
  const fila = [...prsDoMaisAntigoAoMaisNovo]
  return comecarPeloMaisAntigo ? fila : fila.reverse()
}

/**
 * De qual ponta esta acordada começa.
 *
 * Sai do relógio de propósito: o QA não guarda estado entre acordadas, e
 * inventar um campo no banco para isto seria caro sem ser mais honesto. O
 * minuto alterna a cada acordada da agenda e não depende de nada mais.
 */
export function comecarPeloMaisAntigo(agora: Date): boolean {
  return agora.getMinutes() % 2 === 0
}
