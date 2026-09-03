/**
 * A pergunta do dev assíncrono que ficou sem resposta.
 *
 * MEDIDO AO VIVO em 26/08: treze sessões presas em AWAITING_USER_FEEDBACK, a
 * mais antiga desde 19 — sete dias — TODAS marcadas no banco como se já
 * tivessem sido respondidas. Nenhuma tinha. A vigília gravava a marca da
 * pergunta e SÓ DEPOIS disparava a missão que responde; quando a missão
 * falhava, a pergunta ficava marcada para sempre e a sessão morria esperando.
 *
 * A primeira correção trocou esse defeito por outro, achado numa revisão que
 * encadeou ciclos de verdade em vez de olhar uma passagem só — e os dois novos
 * eram piores:
 *
 * - o campo guardava DOIS significados que se sobrescreviam (o hash da
 *   pergunta pendente e a marca de "desisti desta"), então a cada ciclo o
 *   produto alternava entre os dois: tentava, desistia, achava que era
 *   pergunta nova, tentava de novo — motor queimado para sempre e o mesmo
 *   aviso chegando ao dono a cada dois ciclos;
 * - o teto vinha de um contador COMPARTILHADO com outros ramos da vigília,
 *   então o orçamento de uma pergunta era consumido por uma sessão travada
 *   sem relação nenhuma. Pior: o aviso ao dono dizia "tentei 3 vezes" quando
 *   tinha tentado uma. Isso é mentira, e mentira é o que este projeto não
 *   admite.
 *
 * A raiz dos dois era a mesma: um campo só, com significado ambíguo, e um
 * contador emprestado. A marca agora carrega TUDO o que a decisão precisa —
 * o que aconteceu, com qual pergunta, e quantas vezes se tentou ESTA. Nada é
 * inferido de fora, nada é emprestado.
 */

/**
 * Teto de tentativas POR PERGUNTA.
 *
 * Deliberadamente separado do contador geral de cutucadas da vigília: aquele é
 * consumido por sessão travada, pedido de retomada e investigação de falha, e
 * misturar os dois fazia o produto desistir de uma pergunta que mal tinha sido
 * tentada — e dizer ao dono um número que não aconteceu.
 */
export const MAX_TENTATIVAS_DE_RESPOSTA = 3

/**
 * Por quanto tempo uma reserva conta como "em voo".
 *
 * Quinze minutos: as missões de QA medidas em produção levam de trinta
 * segundos a poucos minutos, então quinze cobre com folga a mais lenta sem
 * deixar uma reserva órfã (ciclo morto no meio) travando a pergunta por muito
 * tempo. Curto demais reabre a corrida; longo demais prende trabalho vivo
 * atrás de um fantasma.
 */
export const JANELA_DE_TENTATIVA_EM_VOO_MS = 15 * 60_000

/**
 * A4 (fix-up L4-T3, DÍVIDA — não resolver agora): `answered_hash` (a coluna
 * real por trás de `DevSession.answeredHash`, ver schema.prisma) carrega
 * TRÊS significados de negócio bem diferentes dentro do mesmo campo de texto
 * (`respondida:`/`desisti:`/`escalada:`, além do em-voo `tentando:`) — cada
 * um decodificado por `lerMarca` abaixo a partir de um prefixo dentro de uma
 * string, nunca por uma coluna própria. Funciona porque `lerMarca` é a
 * ÚNICA porta de leitura (nenhum outro lugar faz `startsWith` direto na
 * coluna, exceto o único caso documentado em `marcarEscalada` acima:
 * `session-watch.ts`), mas é uma dívida: um estado novo (ex.: uma L4-T4
 * que precisasse de um 5º significado) tem que caber no MESMO formato
 * `<situação>:<tentativas>:<hash>` ou reabre a ambiguidade que a introdução
 * deste arquivo documenta (dois significados se sobrescrevendo). A correção
 * de verdade é uma coluna própria (ou uma tabela via ledger, no padrão que
 * o resto do produto já usa para histórico) — fora do escopo desta task;
 * fica registrado aqui para a L4-T4 (ou quem mexer aqui depois) não
 * redescobrir o problema do zero.
 */
type Situacao = 'tentando' | 'respondida' | 'desisti' | 'escalada'

interface MarcaLida {
  situacao: Situacao
  hash: string
  tentativas: number
}

/**
 * A marca guardada na linha da sessão.
 *
 * Formato `<situação>:<tentativas>:<hash>`. Feio de propósito: é um campo de
 * texto que já existia, e inventar tabela nova para três informações seria
 * caro sem ser mais honesto. O que importa é que a marca é AUTOSSUFICIENTE —
 * lida sozinha, ela responde "o que aconteceu com qual pergunta, e quantas
 * vezes" sem depender de nenhum contador de fora.
 */
export function marcarTentativa(hash: string, tentativas: number): string {
  return `tentando:${tentativas}:${hash}`
}

/** A resposta SAIU. Encerra o assunto: nem retentativa, nem motor, nem aviso. */
export function marcarRespondida(hash: string): string {
  return `respondida:0:${hash}`
}

/** Bateu o teto e o dono já foi avisado — uma vez, e não a cada ciclo. */
export function marcarDesistencia(hash: string, tentativas: number): string {
  return `desisti:${tentativas}:${hash}`
}

/**
 * A pergunta subiu de VERDADE ao dono (L4-T3) — nunca "respondida".
 *
 * MEDIDO ao vivo em 02/09: 24 sessões marcadas `respondida:0:<hash>` no
 * instante da escalada, ANTES de qualquer `agent_question` existir — e
 * `agent_questions` com ZERO linhas de dedupKey `duvida-dev:*`. O produto
 * achava que tinha perguntado; ninguém nunca viu nada. `escalada` é um
 * terceiro estado, distinto de `respondida`: ninguém respondeu ainda (é o
 * dono quem vai responder — e a resposta dele RETOMA a sessão, ver
 * `services/retomar-sessao-com-resposta.ts`), mas a MESMA pergunta também não
 * pode ser refeita a cada acordada do QA (gastaria motor formulando de novo
 * uma pergunta que já está na mesa do dono).
 *
 * Mantém o formato de três partes (`<situação>:<tentativas>:<hash>`) das
 * irmãs acima — não um simples `'escalada:' + hash` solto — porque é isso
 * que permite `lerMarca`/`decidirSobreAPergunta` reconhecerem o estado pela
 * MESMA leitura que já existe, sem um segundo formato de marca no mesmo
 * campo. `startsWith('escalada:')` continua válido para quem só precisa do
 * prefixo (ex.: `session-watch.ts`).
 */
export function marcarEscalada(hash: string): string {
  return `escalada:0:${hash}`
}

/**
 * Lê a marca. Formato desconhecido (ou marca de uma versão anterior) vira
 * "nunca vi esta pergunta" de propósito: é o padrão seguro — no pior caso o
 * produto tenta uma vez a mais, em vez de desistir de uma pergunta viva.
 */
export function lerMarca(bruto: string | null): MarcaLida | null {
  if (!bruto) return null
  const partes = bruto.split(':')
  if (partes.length < 3) return null
  const [situacao, tentativas, ...resto] = partes
  if (
    situacao !== 'tentando' &&
    situacao !== 'respondida' &&
    situacao !== 'desisti' &&
    situacao !== 'escalada'
  )
    return null
  const n = Number(tentativas)
  if (!Number.isInteger(n) || n < 0) return null
  return { situacao, hash: resto.join(':'), tentativas: n }
}

/**
 * C5 (fix-up 3, task a13a42f8-2953-4259-b41f-3f8cddb304cd): fonte ÚNICA de
 * "isto é uma marca de escalada". Antes desta extração, `sessao-abandonada.ts`
 * (`ehDuvidaEscaladaAoDono`) e `session-watch.ts` faziam
 * `answeredHash?.startsWith('escalada:')` cada um por conta própria — um
 * terceiro `startsWith` solto (ou um jeito novo de escrever a marca) bastaria
 * para os dois divergirem sem erro de tipo nenhum. Passa pela MESMA leitura
 * de `lerMarca` que decide tudo o mais sobre a marca (formato de três partes
 * `<situação>:<tentativas>:<hash>`, nunca um simples prefixo solto): uma
 * marca truncada ou de formato desconhecido (`'escalada'` sem as partes, por
 * exemplo) devolve `false` aqui do MESMO jeito que devolve `null` em
 * `lerMarca` — nunca um falso positivo por bater só o prefixo.
 */
export function ehMarcaDeEscalada(bruto: string | null | undefined): boolean {
  return lerMarca(bruto ?? null)?.situacao === 'escalada'
}

export type DecisaoSobreAPergunta =
  /** Tentar responder. `tentativa` é a contagem DESTA pergunta, para a marca. */
  | { acao: 'responder'; tentativa: number }
  /** Bateu o teto agora: avisa o dono UMA vez e marca a desistência. */
  | { acao: 'desistir'; tentativas: number }
  /** Nada a fazer: já respondida, ou já desistimos e o dono já sabe. */
  | { acao: 'nada'; motivo: string }

/**
 * O que fazer com a pergunta que está na mesa.
 *
 * Tudo sai da marca e do hash da pergunta atual — nenhum contador de fora,
 * nenhum estado ambíguo. É isso que impede a oscilação: a marca sempre carrega
 * COM QUAL pergunta ela fala, então "desisti desta" nunca mais é confundido
 * com "chegou uma pergunta nova".
 */
export function decidirSobreAPergunta(args: {
  hashDaPergunta: string
  marca: string | null
  /**
   * Quando a marca foi escrita (`stateCheckedAt`, carimbado pela reserva).
   * Ausente = comportamento de antes, para quem ainda não passa o dado.
   */
  marcadaEm?: Date | null | undefined
  agora?: Date | undefined
}): DecisaoSobreAPergunta {
  const lida = lerMarca(args.marca)

  // Pergunta diferente da que a marca descreve: conversa nova, e conversa nova
  // começa do zero. O teto NUNCA é herdado — um diálogo longo e legítimo (o
  // dev pergunta, recebe, pergunta outra coisa) não pode ser confundido com
  // uma pergunta que ninguém conseguiu responder.
  if (!lida || lida.hash !== args.hashDaPergunta) {
    return { acao: 'responder', tentativa: 1 }
  }

  if (lida.situacao === 'respondida') {
    return { acao: 'nada', motivo: 'esta pergunta já foi respondida' }
  }
  if (lida.situacao === 'desisti') {
    return { acao: 'nada', motivo: 'já desistimos desta pergunta e o dono já foi avisado' }
  }
  if (lida.situacao === 'escalada') {
    // L4-T3: já subiu ao dono de verdade (agent_question com dedupKey
    // duvida-dev:*). Não é "respondida" (ninguém respondeu ainda), mas
    // também não se reformula a cada ciclo — a resposta do dono é quem
    // resolve isto, por `retomar-sessao-com-resposta.ts`.
    return {
      acao: 'nada',
      motivo: 'esta pergunta já foi escalada ao dono e aguarda a decisão dele',
    }
  }

  // ALGUÉM ESTÁ TENTANDO AGORA — não some por cima.
  //
  // MEDIDO AO VIVO em 27/08, com a devolução de tentativa (PR #277) já no ar e
  // funcionando (66 devoluções em duas horas): as tarefas #248 e #3799 mesmo
  // assim chegaram a `desisti:3`. A corrida:
  //
  //   1. O ciclo A lê a marca, decide a tentativa 1 e grava `tentando:1`.
  //   2. O ciclo A chama o motor — que demora, e vai falhar por cota.
  //   3. O ciclo B acorda no meio, lê `tentando:1` e conclui que a tentativa 1
  //      JÁ ACONTECEU: sobe para 2 e grava `tentando:2`. A escrita condicional
  //      dele é válida, porque `tentando:1` de fato ainda estava lá.
  //   4. O ciclo A falha e vai devolver a vez — mas a devolução é condicional a
  //      `tentando:1`, que já não existe. Não escreve nada, e a tentativa
  //      morreu gasta.
  //
  // A raiz é a marca não distinguir "alguém está tentando AGORA" de "a
  // tentativa N terminou e falhou". Com o carimbo da reserva na mão, dá para
  // separar os dois — e o carimbo já era gravado, só não era lido.
  //
  // Marca VELHA continua subindo o contador de propósito: é o ciclo que morreu
  // sem devolver (processo reiniciado no meio, por exemplo). Sem isso a
  // pergunta ficaria presa para sempre atrás de uma reserva fantasma, que é
  // trocar um jeito de perder trabalho por outro.
  if (args.marcadaEm && args.agora) {
    const idade = args.agora.getTime() - args.marcadaEm.getTime()
    if (idade >= 0 && idade < JANELA_DE_TENTATIVA_EM_VOO_MS) {
      return { acao: 'nada', motivo: 'já tem uma tentativa em voo para esta pergunta' }
    }
  }

  const proxima = lida.tentativas + 1
  if (proxima > MAX_TENTATIVAS_DE_RESPOSTA) {
    return { acao: 'desistir', tentativas: lida.tentativas }
  }
  return { acao: 'responder', tentativa: proxima }
}
