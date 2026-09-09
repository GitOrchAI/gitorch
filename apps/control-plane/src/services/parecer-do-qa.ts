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

/**
 * Marca invisível que só o parecer de uma entrega NÃO DELEGADA carrega.
 *
 * Existe para desfazer um beco sem saída. Durante a janela cega — entre a
 * abertura do pull request e a gravação da ligação issue↔sessão — o
 * julgamento não encontrava a linha da sessão e concluía que a entrega era de
 * terceiro: opinava por comentário em vez de aprovar formalmente. Quando a
 * ligação chegava depois, o laço de descoberta já tratava aquele parecer como
 * "julgado, ponto final" e pulava a entrega PARA SEMPRE. O pull request ficava
 * aberto, com verificação verde, esperando uma aprovação formal que nunca
 * viria porque o produto acreditava já ter opinado.
 *
 * A marca é o que permite a um ciclo futuro reconhecer que aquele parecer foi
 * emitido sob premissa errada. Ela vive no CORPO da review, e não na memória
 * do processo, justamente porque quem precisa lê-la é um ciclo que ainda não
 * existia quando o parecer saiu.
 */
export const MARCA_SEM_PODER_DE_MESCLAR = '<!-- gitorch:qa:sem-poder-de-mesclar -->'

/**
 * A frase que o produto publicou, antes de a marca existir, em todo parecer
 * sobre entrega não delegada.
 *
 * Serve de reconhecimento para os pareceres LEGADOS. Sem ela, os pull requests
 * que motivaram este conserto — os que já levaram parecer na janela cega —
 * continuariam presos no beco, e o conserto chegaria tarde demais justamente
 * para eles. É um trecho estável e distintivo, e some sozinho conforme esses
 * pull requests vão sendo fechados.
 */
export const AVISO_LEGADO_DE_NAO_MESCLAR = 'esta entrega não foi encomendada pelo produto'

/**
 * Marca invisível de uma reprovação que NÃO é sobre o código.
 *
 * O produto tem uma trava determinística: quando o motor diz "aprovar" mas a
 * verificação não está verde (ou o diff não coube por inteiro), o veredito é
 * REBAIXADO para "pedir mudanças". A trava está certa e não muda — aprovar com
 * verificação vermelha seria mesclar no escuro.
 *
 * O que faltava era a VOLTA. Uma reprovação dessas não diz nada sobre a
 * qualidade da entrega: diz que, naquele instante, o portão estava fechado. Se
 * a verificação fica verde depois no MESMO commit — reexecução do CI, teste
 * instável que passou na segunda, conserto de infraestrutura no repositório —,
 * o motivo da reprovação deixou de existir e ninguém voltava atrás. O laço de
 * descoberta tratava a reprovação como julgamento final e pulava para sempre.
 *
 * Foi isso que travou um projeto inteiro: medido em 23/08/2026, o repositório
 * loureng/patinhas-3d-crafts tinha ZERO entregas mescladas em treze sessões,
 * com pull requests de verificação verde parados esperando um veredito que
 * nunca vinha. O PR #3768 estava CLEAN, com o CI inteiro verde, e a única
 * review nossa no head atual era um "pedir mudanças" emitido quando o CI ainda
 * estava vermelho.
 */
export const MARCA_DE_REPROVACAO_CONDICIONAL = '<!-- gitorch:qa:reprovado-pelo-portao -->'

/**
 * Marca invisível que registra: esta review foi emitida com a verificação
 * VERMELHA.
 *
 * Substitui e generaliza a marca acima, e a diferença veio de ler a saída real
 * em vez do código. Eu tinha assumido que "reprovado por causa do CI" vinha
 * sempre da trava determinística — o motor aprova, o CI não está verde, o
 * sistema rebaixa. Marquei o rebaixamento.
 *
 * O comentário que o julgamento deixou no PR #3768 mostrou o contrário:
 *
 *     "Resolve the CI failures by identifying the root cause of the red
 *      status (...) The current CI status is reported as red."
 *
 * O MOTOR leu o CI vermelho e reprovou sozinho. Não houve rebaixamento nenhum,
 * e a marca do portão nunca seria escrita. E esse é o caminho que acontece na
 * prática, porque o próprio prompt do julgamento manda "You MUST NOT approve
 * when CI is not green" — o motor obedece antes de a trava precisar agir.
 *
 * Registrar o ESTADO em vez da ORIGEM cobre os dois caminhos: não importa quem
 * decidiu, importa que a verificação estava vermelha naquele instante. Se ela
 * ficar verde depois no mesmo commit, o motivo caiu.
 */
export const MARCA_JULGADO_COM_CI_VERMELHO = '<!-- gitorch:qa:ci-vermelho-no-julgamento -->'

/**
 * Este parecer é o rejulgamento único dado a uma entrega presa por uma
 * reprovação escrita antes de o produto corrigir a leitura do CI.
 *
 * Existe para a cortesia acontecer UMA vez: sem o carimbo, cada varredura
 * reabriria o mesmo PR e viraria opinião repetida no pull request do cliente.
 */
export const MARCA_DE_LEGADO_REJULGADO = '<!-- gitorch:qa:legado-rejulgado -->'

/** Este parecer já é o rejulgamento do legado? */
export function temMarcaDeRejulgamentoDeLegado(review?: ReviewDoGithub | null): boolean {
  return Boolean(review?.body?.includes(MARCA_DE_LEGADO_REJULGADO))
}

export interface ReviewDoGithub {
  body?: string
  commit_id?: string
  /** Quando o parecer foi publicado — usado para separar o legado do novo. */
  submitted_at?: string
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

/**
 * Diz se este parecer foi emitido por quem NÃO podia mesclar.
 *
 * Exige a marca do parecer em todos os caminhos: sem ela, um humano que
 * colasse o texto do aviso num comentário faria o produto tratar a opinião de
 * um terceiro como se fosse a sua.
 */
export function ehParecerSemPoderDeMesclar(review: ReviewDoGithub | undefined): boolean {
  const corpo = review?.body ?? ''
  if (!corpo.includes(MARCA_DO_PARECER)) return false
  return corpo.includes(MARCA_SEM_PODER_DE_MESCLAR) || corpo.includes(AVISO_LEGADO_DE_NAO_MESCLAR)
}

/**
 * Esta reprovação foi por causa do PORTÃO, e não do código?
 *
 * Exige a marca do parecer: sem ela, um humano que colasse o texto num
 * comentário faria o produto reabrir um julgamento que não é seu.
 */
export function ehReprovacaoCondicional(review: ReviewDoGithub | undefined): boolean {
  const corpo = review?.body ?? ''
  return corpo.includes(MARCA_DO_PARECER) && corpo.includes(MARCA_DE_REPROVACAO_CONDICIONAL)
}

/**
 * Esta review foi emitida enquanto a verificação estava vermelha?
 *
 * Aceita também a marca antiga do portão: ela é um caso particular deste — o
 * rebaixamento só acontecia quando o CI não estava verde. Reconhecer as duas
 * evita deixar preso o que foi marcado nas horas entre um conserto e outro.
 *
 * Exige a marca do parecer: sem ela, um humano que colasse o texto num
 * comentário faria o produto reabrir um julgamento que não é seu.
 */
export function foiJulgadoComCiVermelho(review: ReviewDoGithub | undefined): boolean {
  const corpo = review?.body ?? ''
  if (!corpo.includes(MARCA_DO_PARECER)) return false
  return (
    corpo.includes(MARCA_JULGADO_COM_CI_VERMELHO) || corpo.includes(MARCA_DE_REPROVACAO_CONDICIONAL)
  )
}

/** O parecer encontrado é uma aprovação? */
export function ehAprovacao(review: ReviewDoGithub | undefined): boolean {
  return Boolean(review && (review.body ?? '').includes(MARCA_DE_APROVACAO))
}
