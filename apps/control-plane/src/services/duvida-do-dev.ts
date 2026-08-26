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
  /** Decisão de negócio, ou o agente não soube: quem responde é o dono. */
  | { tipo: 'perguntar-ao-dono'; motivo: string }

/**
 * Para onde vai a dúvida.
 *
 * Duas portas, e o caminho para o dono é o padrão seguro: qualquer coisa que
 * não seja uma resposta técnica boa sobe para quem pode decidir. Errar para
 * este lado custa uma pergunta a mais no chat do dono; errar para o outro
 * custa uma resposta inventada dentro do trabalho dele.
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
      tipo: 'perguntar-ao-dono',
      motivo:
        'não consegui responder olhando o repositório, e mandar uma resposta vazia ao dev ' +
        'só faria ele perguntar de novo.',
    }
  }
  return { tipo: 'responder-o-dev', resposta: args.resposta.trim() }
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
