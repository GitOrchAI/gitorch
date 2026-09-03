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

/**
 * O texto aponta para algo REAL do repositório (arquivo, crase, função(),
 * caminho src/apps/packages/lib/scripts)?
 *
 * Exportada (L4-T4, D64) para `suporSemODono` (duvida-rails-mission.ts)
 * aplicar o MESMO freio de concretude à suposição do RA — sem isto, uma
 * suposição bem escrita mas sem lastro nenhum no código passaria e o dev
 * receberia uma opinião genérica em vez de algo que de fato o desbloqueia.
 * As 3 portas de `destinoDaDuvida`/`destinoAposRa` abaixo continuam
 * chamando só `ehRespostaUtil` — este export não muda o comportamento delas.
 */
export function citaAlgoConcreto(texto: string): boolean {
  return CITA_ALGO_CONCRETO.some((padrao) => padrao.test(texto))
}

/** A resposta serve para mandar ao dev? */
export function ehRespostaUtil(resposta: string): boolean {
  const limpa = resposta.trim()
  if (limpa.length < MIN_CARACTERES_DE_RESPOSTA) return false
  if (RENDICOES.some((padrao) => padrao.test(limpa))) return false
  // Tem que apontar para algo real do repositório. Sem isto, uma opinião
  // genérica bem escrita passava — e opinião genérica não desbloqueia
  // ninguém, só faz o produto achar que respondeu.
  return citaAlgoConcreto(limpa)
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
  /**
   * Decisão de NEGÓCIO de verdade — nunca se adivinha — ou nem o RA soube.
   *
   * `perguntaExecutiva`/`opcoes` só existem quando o próprio modelo já
   * traduziu a pergunta para uma decisão de negócio em português, com opções
   * objetivas (D14, 01/09) — nunca o texto técnico cru do dev. Ausentes: quem
   * mostra a pergunta ao dono decide o texto de reserva (nunca despeja o
   * inglês do dev sem avisar que não deu para traduzir).
   */
  | {
      tipo: 'perguntar-ao-dono'
      motivo: string
      perguntaExecutiva?: string
      opcoes?: Array<{ label: string; value: string }>
    }

/**
 * Sinal determinístico: a pergunta descreve um TRABALHO JÁ FEITO (o código já
 * existe, já foi corrigido, já está implementado) e pede orientação de
 * PROCESSO sobre como fechar a tarefa — isto é decisão técnica/de processo
 * (comentar, fechar, abrir PR vazio), NUNCA decisão de negócio.
 *
 * Existe porque o modelo errou exatamente este caso ao vivo (D14, 01/09,
 * tarefa #46 de GitOrchAI/gitorch): a pergunta era "o /wishlist já está
 * implementado no commit d175cb70, o que faço?" e o modelo marcou
 * `precisaDoDono=true`, acordando o dono à toa com uma pergunta técnica em
 * inglês cru. `precisaDoDono` é AUTO-DECLARAÇÃO do modelo — sem um freio
 * determinístico aqui, o mesmo erro se repete toda vez que o modelo confundir
 * "eu não posso decidir isso sozinho" com "isto é decisão de negócio". O
 * prompt (duvida-rails-mission.ts) também foi reforçado — isto é o
 * SEGUNDO freio, não o único.
 */
const SINAIS_DE_TRABALHO_JA_FEITO = [
  /\balready\s+(?:been\s+)?(?:implemented|fixed|present|done|corrected|exists?|resolved)\b/i,
  /\bhas\s+already\s+been\s+(?:implemented|fixed|corrected|resolved|added)\b/i,
  /\bj[áa]\s+(?:est[áa]|foi)\s+(?:implementad[oa]|corrigid[oa]|feit[oa]|resolvid[oa]|presente)\b/i,
  /\b(?:this|the)\s+(?:bug|issue|feature|fix)\s+(?:is|has been)\s+already\b/i,
]

/** A pergunta descreve trabalho já feito, pedindo só orientação de processo? */
export function pareceTrabalhoJaFeito(pergunta: string): boolean {
  return SINAIS_DE_TRABALHO_JA_FEITO.some((padrao) => padrao.test(pergunta))
}

/**
 * Para onde vai a dúvida, na primeira passada (QA).
 *
 * Três portas. `precisaDoDono` é o jeito PRINCIPAL de chegar direto ao dono
 * aqui — é a declaração do próprio agente de que é decisão de negócio, e
 * decisão de negócio não se adivinha. Qualquer coisa técnica que o QA não
 * conseguiu resolver vai para o RA antes, nunca direto para o dono: o dono
 * não deveria receber uma pergunta que o produto ainda nem tentou resolver a
 * sério.
 *
 * EXCEÇÃO (D14): quando a própria pergunta descreve trabalho já feito
 * (`pareceTrabalhoJaFeito`), a declaração do modelo é IGNORADA — isto é
 * decisão técnica/de processo por definição, mesmo que o modelo tenha
 * marcado `precisaDoDono=true`.
 */
export function destinoDaDuvida(args: {
  /** O próprio agente declarou que isto é decisão de negócio. */
  precisaDoDono: boolean
  /** O que o agente escreveu como resposta. */
  resposta: string
  /** A pergunta original do dev — usada só pelo freio determinístico acima. */
  pergunta?: string
  /** Tradução executiva em português + opções, quando o modelo já preparou (D14). */
  perguntaExecutiva?: string
  opcoes?: Array<{ label: string; value: string }>
}): DestinoDaDuvida {
  if (args.precisaDoDono && args.pergunta && pareceTrabalhoJaFeito(args.pergunta)) {
    return {
      tipo: 'escalar-ao-ra',
      motivo:
        'a pergunta descreve trabalho já feito (código já existe/já corrigido) — isto é decisão ' +
        'técnica/de processo (fechar a tarefa, comentar, abrir PR vazio), nunca decisão de ' +
        'negócio, mesmo com o modelo tendo marcado como tal.',
    }
  }
  if (args.precisaDoDono) {
    return {
      tipo: 'perguntar-ao-dono',
      motivo: 'é decisão de negócio, e decisão de negócio é do dono — não se adivinha.',
      ...(args.perguntaExecutiva ? { perguntaExecutiva: args.perguntaExecutiva } : {}),
      ...(args.opcoes && args.opcoes.length > 0 ? { opcoes: args.opcoes } : {}),
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
/**
 * D72 (02/09) — o dono flagrou 4 "Esperando você" que NÃO eram perguntas: um
 * relatório de conclusão do dev ("I have successfully modified the code and
 * verified the tests are passing...", tarefa #309 de GitOrchAI/gitorch)
 * tratado como dúvida técnica sem resposta. `responderDuvidaPendente`
 * (scheduler.ts) lê a ÚLTIMA MENSAGEM de qualquer sessão AWAITING_USER_FEEDBACK
 * e mandava direto para a missão de QA "responda esta pergunta" — mesmo
 * quando não havia pergunta nenhuma. Sem este freio, o QA (e depois o RA)
 * tentavam "responder" um não-pergunta, normalmente falhavam a ehRespostaUtil,
 * e o caso acabava escalado ao dono, em inglês, sem opções.
 *
 * Roda ANTES das 3 portas de `destinoDaDuvida`/`destinoAposRa` (que não
 * mudam) — intercepta o caso comum de a sessão não ter perguntado nada.
 */
export type ClassificacaoDaMensagemDoDev =
  /** O dev avisou que terminou (ou fez progresso) — não perguntou nada. */
  | 'relatorio-de-conclusao'
  /** O dev está esperando aprovação de um plano — nunca decisão do dono. */
  | 'pedido-de-aprovacao-de-plano'
  /** Alguma coisa que de fato precisa de resposta. */
  | 'pergunta'

// Verbos/frases de conclusão — reconhecidos de propósito nos DOIS idiomas,
// porque o dev assíncrono (Jules) escreve em inglês e o produto também fala
// com o dono em português.
const SINAIS_DE_RELATORIO_DE_CONCLUSAO = [
  /\bsuccessfully\b/i,
  /\btests?\s+(are|is|were)\s+passing\b/i,
  /\b(i\s+have|i've)\s+(implemented|completed|finished|fixed|modified|verified)\b/i,
  /\bimplementation\s+is\s+complete\b/i,
  /\bready\s+for\s+review\b/i,
  /\bimplementad[oa]s?\s+com\s+sucesso\b/i,
  /\bconclu[ií]d[oa]\b/i,
  /\bterminei\b/i,
]

// Só conta como pedido de aprovação de PLANO quando a linguagem é
// explicitamente sobre aprovar/esperar aprovação — NUNCA por citar "plan"
// de passagem (D72: o segundo print do dono citava "the plan" dentro de um
// feedback de review, mas a pergunta de verdade era outra — confundir os
// dois faria uma dúvida técnica real desaparecer sem resposta).
const SINAIS_DE_PEDIDO_DE_APROVACAO_DE_PLANO = [
  /\b(approve|approval)\s+(of\s+|the\s+)?(the\s+)?plan\b/i,
  /\bplan\s+is\s+ready.{0,40}\bapproval\b/i,
  /\bwaiting\s+for\s+(plan\s+)?approval\b/i,
  /\bawaiting\s+(plan\s+)?approval\b/i,
  /\baguardando\s+aprova[cç][aã]o\b/i,
  /\baprovar\s+o\s+plano\b/i,
]

/**
 * A mensagem do dev é de fato uma pergunta — ou é outra coisa (relatório de
 * conclusão, pedido de aprovação de plano) que a missão de QA não devia nem
 * tentar "responder"?
 *
 * Determinístico de propósito, como o resto deste arquivo: um relatório de
 * conclusão com "?" no meio (ex.: "fiz X, devo fazer Y também?") CONTINUA
 * pergunta — a presença de "?" nunca vira relatório.
 */
export function classificarMensagemDoDev(mensagem: string): ClassificacaoDaMensagemDoDev {
  const texto = mensagem.trim()
  if (SINAIS_DE_PEDIDO_DE_APROVACAO_DE_PLANO.some((padrao) => padrao.test(texto))) {
    return 'pedido-de-aprovacao-de-plano'
  }
  const temInterrogacao = texto.includes('?')
  if (!temInterrogacao && SINAIS_DE_RELATORIO_DE_CONCLUSAO.some((padrao) => padrao.test(texto))) {
    return 'relatorio-de-conclusao'
  }
  return 'pergunta'
}

/**
 * O texto que o dev recebe quando só avisou que terminou — nunca vira
 * pergunta ao dono, nunca gasta um ciclo de QA/RA tentando "responder" um
 * relatório. Pede a ação de processo que realmente destrava a tarefa: abrir/
 * atualizar o PR.
 */
export function textoParaRelatorioDeConclusao(): string {
  return [
    'GitOrch (resposta automática):',
    '',
    'Entendido. Finalize a entrega: abra ou atualize o pull request desta tarefa e sinalize a ' +
      'conclusão.',
  ].join('\n')
}

/**
 * O texto que o dev recebe quando parece estar esperando aprovação de plano
 * dentro de uma sessão AWAITING_USER_FEEDBACK — a aprovação de verdade
 * acontece pelo estado AWAITING_PLAN_APPROVAL (jules-session-loop.ts,
 * automática, nunca passa pelo dono); isto aqui é só a instrução para o dev
 * seguir sem acordar ninguém à toa.
 */
export function textoParaPedidoDeAprovacaoDePlano(): string {
  return [
    'GitOrch (resposta automática):',
    '',
    'Entendido. A aprovação do plano acontece automaticamente quando a sessão chega nesse ' +
      'estado — continue o trabalho. Se ainda houver uma dúvida técnica real, descreva-a como ' +
      'uma pergunta direta.',
  ].join('\n')
}

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
