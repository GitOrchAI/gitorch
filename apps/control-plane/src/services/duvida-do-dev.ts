/**
 * A dúvida do dev assíncrono — e quem a responde.
 *
 * Pedido literal do dono: "esta com duvidas ? responde !".
 *
 * O que existia até aqui era decorativo. Quando o dev ficava em
 * AWAITING_USER_FEEDBACK, a vigília acordava o QA e contava a linha como
 * "respondida" no log — mas a missão de QA só sabe julgar pull request. Ela
 * nunca lia a pergunta e nunca escrevia de volta. Provado pela API do serviço
 * em 26/08: uma pergunta de 19/08 seguia sem uma única mensagem de resposta,
 * sete dias depois, enquanto o log dizia "respondida".
 *
 * Cada pergunta sem resposta congela uma vaga. Treze vagas congeladas estouram
 * o teto de quinze simultâneas e param a esteira inteira — é isso que faz o
 * produto parecer travado sem motivo.
 *
 * A lei que manda aqui: o agente NÃO INVENTA. Dúvida técnica ele resolve
 * lendo o repositório; dúvida de negócio é do dono, e para isso já existe o
 * caminho de perguntar com botões no chat. E resposta ruim não vira mensagem:
 * mandar "não sei" para o dev é pior que o silêncio, porque ele volta a
 * perguntar e a vaga continua presa do mesmo jeito.
 */

/**
 * O piso de tamanho de uma resposta que desbloqueia alguém.
 *
 * Não é estética: "ok", "sim" e "use o padrão" não tiram ninguém do lugar. O
 * dev volta a perguntar, a sessão continua em espera, e o produto terá gasto
 * um motor para não mudar nada.
 */
export const MIN_CARACTERES_DE_RESPOSTA = 40

/**
 * Frases com que um modelo se rende quando não sabe.
 *
 * Reconhecidas de propósito: enviadas ao dev, elas parecem resposta e não são
 * — e o custo é o pior dos dois mundos, porque o produto acha que respondeu.
 * Quando a resposta cai aqui, a dúvida sobe para o dono, que é quem de fato
 * pode destravar.
 */
const RENDICOES = [
  // Rendições explícitas.
  /\bnão sei\b/i,
  /\bnao sei\b/i,
  /\bi (don'?t|do not) know\b/i,
  /\bi need more (information|context)\b/i,
  /\bi (cannot|can'?t) (determine|tell|answer)\b/i,
  /\bunable to (determine|answer)\b/i,
  /\bnão (é possível|foi possível) determinar\b/i,
  // A rendição EDUCADA, que é a que escapava: o modelo não diz "não sei", diz
  // que faltou contexto, que seria preciso testar, que depende. Enviada ao
  // dev, parece resposta e não é — e o pior é que o produto passa a achar que
  // respondeu. Este grupo existe porque a lista curta de rendições explícitas
  // deixava passar exatamente essas frases.
  /\b(seria|é) preciso (testar|verificar|investigar|confirmar)\b/i,
  /\bnão (dá|da) para (dizer|saber|afirmar|confirmar)\b/i,
  /\b(sem|falta) (mais )?(contexto|informaç)/i,
  /\bdepende de (mais|como|qual)\b/i,
  /\bwould need (more|to)\b/i,
  /\bnot enough (context|information)\b/i,
  /\bit depends on\b/i,
]

/**
 * Uma resposta técnica de verdade aponta para ALGUMA COISA concreta: um
 * arquivo, um pacote, um comando, um símbolo do código. Uma que não aponta
 * para nada é opinião genérica — o tipo de texto que passa no tamanho, não
 * bate em nenhuma frase de rendição, e ainda assim não move o dev um
 * centímetro. Foi o buraco que a revisão apontou: os dois filtros anteriores
 * mediam forma, nenhum media substância.
 */
const CITA_ALGO_CONCRETO = [
  /[\w.-]+\.(ts|tsx|js|jsx|json|sql|yml|yaml|sh|md|py|go|rs|prisma)\b/i,
  /`[^`]+`/,
  /\b[a-z][a-zA-Z0-9]*\([^)]*\)/,
  /\b(src|apps|packages|lib|scripts)\//i,
]

/** A resposta serve para mandar ao dev? */
export function ehRespostaUtil(resposta: string): boolean {
  const limpa = resposta.trim()
  if (limpa.length < MIN_CARACTERES_DE_RESPOSTA) return false
  if (RENDICOES.some((padrao) => padrao.test(limpa))) return false
  // Tem que apontar para algo real do repositório. Sem isto, uma opinião
  // genérica bem escrita passava — e opinião genérica não desbloqueia
  // ninguém, só faz o produto achar que respondeu.
  return CITA_ALGO_CONCRETO.some((padrao) => padrao.test(limpa))
}

export type DestinoDaDuvida =
  /** O agente sabe: a resposta vai para a sessão do dev. */
  | { tipo: 'responder-o-dev'; resposta: string }
  /**
   * ESTEIRA-T14 (decisão do dono 29/08): o QA não soube responder, mas isto
   * NÃO é decisão de negócio — antes de incomodar o dono, o RA tenta com mais
   * profundidade (codegraph) e, se acertar, o acerto vira aprendizado para o
   * QA responder sozinho da próxima. Caso real que motivou: o Jules perguntou
   * algo técnico (sync do MercadoLivre, upsert do Prisma) na tarefa #3884 do
   * patinhas e o GitOrch escalou direto ao dono — "se o gitorch me entrega
   * decisões técnicas, eu mesmo faria".
   */
  | { tipo: 'escalar-ao-ra'; motivo: string }
  /** Decisão de NEGÓCIO de verdade — nunca se adivinha — ou nem o RA soube. */
  | { tipo: 'perguntar-ao-dono'; motivo: string }

/**
 * Para onde vai a dúvida, na primeira passada (QA).
 *
 * Três portas. `precisaDoDono` é o único jeito de chegar direto ao dono aqui
 * — é a declaração do próprio agente de que é decisão de negócio, e decisão
 * de negócio não se adivinha. Qualquer coisa técnica que o QA não conseguiu
 * resolver vai para o RA antes, nunca direto para o dono: o dono não deveria
 * receber uma pergunta que o produto ainda nem tentou resolver a sério.
 */
export function destinoDaDuvida(args: {
  /** O próprio agente declarou que isto é decisão de negócio. */
  precisaDoDono: boolean
  /** O que o agente escreveu como resposta. */
  resposta: string
}): DestinoDaDuvida {
  if (args.precisaDoDono) {
    return {
      tipo: 'perguntar-ao-dono',
      motivo: 'é decisão de negócio, e decisão de negócio é do dono — não se adivinha.',
    }
  }
  if (!ehRespostaUtil(args.resposta)) {
    return {
      tipo: 'escalar-ao-ra',
      motivo:
        'o QA não conseguiu responder lendo o repositório — é técnico, então o RA tenta com ' +
        'mais profundidade antes de subir ao dono.',
    }
  }
  return { tipo: 'responder-o-dev', resposta: args.resposta.trim() }
}

/**
 * Para onde vai a dúvida DEPOIS que o RA também tentou.
 *
 * Aqui não existe mais escalar-ao-ra: ou o RA respondeu de verdade, ou
 * ninguém no produto soube — e aí sim é o dono, porque as duas tentativas
 * técnicas se esgotaram.
 */
export function destinoAposRa(resposta: string): DestinoDaDuvida {
  if (!ehRespostaUtil(resposta)) {
    return {
      tipo: 'perguntar-ao-dono',
      motivo: 'nem o QA nem o RA conseguiram responder lendo o repositório.',
    }
  }
  return { tipo: 'responder-o-dev', resposta: resposta.trim() }
}

/**
 * ESTEIRA-T14 — config por projeto de quanto o dono quer ver no chat sobre
 * dúvidas do dev assíncrono (`runtimeConfig.perguntasAoDono`):
 *
 * - `so-executivo` (default): só decisão de negócio real, ou o caso raro em
 *   que QA E RA tentaram e nenhum soube.
 * - `executivo-e-tecnico-bloqueante`: além disso, todo bloqueio técnico vai
 *   direto ao dono (pula o RA) — para quem quer o humano vendo todo travamento.
 * - `tudo`: mesmo comportamento de escalada de `executivo-e-tecnico-bloqueante`,
 *   e AINDA avisa o dono (sem bloquear nada) quando o QA respondeu sozinho —
 *   visibilidade total.
 */
export type PoliticaDePerguntasAoDono = 'so-executivo' | 'executivo-e-tecnico-bloqueante' | 'tudo'

const POLITICAS_VALIDAS = new Set<PoliticaDePerguntasAoDono>([
  'so-executivo',
  'executivo-e-tecnico-bloqueante',
  'tudo',
])

/** Lê `runtimeConfig.perguntasAoDono`, com o default seguro (`so-executivo`). */
export function resolvePoliticaDePerguntasAoDono(
  runtimeConfig: unknown
): PoliticaDePerguntasAoDono {
  const valor = (runtimeConfig as { perguntasAoDono?: string } | null)?.perguntasAoDono
  return POLITICAS_VALIDAS.has(valor as PoliticaDePerguntasAoDono)
    ? (valor as PoliticaDePerguntasAoDono)
    : 'so-executivo'
}

/**
 * O texto que chega na sessão.
 *
 * Diz de quem veio — o dev precisa saber que não é o dono digitando, para
 * calibrar o peso do que leu — e manda seguir. A resposta sozinha não tira a
 * sessão do limbo: o serviço só sai de "esperando" quando o trabalho recomeça.
 */
export function textoDaRespostaAoDev(resposta: string): string {
  return [
    'GitOrch (resposta automática à sua pergunta):',
    '',
    resposta.trim(),
    '',
    'Com isso, continue o trabalho de onde parou. Se ainda houver algo bloqueando, diga o ' +
      'que é em vez de parar em silêncio.',
  ].join('\n')
}
