import { sprintCorrente, type Iteracao } from './garantir-sprint.js'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { PREFIXO_DUVIDA_DEV } from './dedup-key-de-duvida.js'

/**
 * L4-T23 (04/09) — o dono recusou a pergunta de reserva ("O dev está
 * travado numa dúvida técnica na tarefa #3716 de loureng/patinhas-3d-crafts
 * e nem o RA conseguiu resolver. O que fazer?"): não quer saber da dúvida do
 * dev, quer a LÓGICA — o ciclo corrente, o que a tarefa entrega, o que QA/
 * PO/RA já resolveram sozinhos — e só então a decisão de negócio que sobra.
 *
 * Este módulo reúne essas 4 peças a partir de 3 fontes que já existem no
 * produto e nunca tinham sido lidas JUNTAS para uma pergunta ao dono:
 *   - o ciclo corrente do quadro (`garantir-sprint.ts`/`project-v2-client.ts`
 *     — só id/título/início/duração, NUNCA um objetivo de sprint: o recado
 *     de status que o produto escreve não é lido de volta, D73);
 *   - o que a tarefa entrega (a seção "## Goal" do corpo da issue,
 *     `secao-da-issue.ts` — o único texto de negócio garantido é
 *     `usableOutcome`, mas esse é por FASE, não por tarefa; a issue confia
 *     no que o modelo escreveu em "Goal");
 *   - as decisões que o próprio dono já tomou nesta MESMA tarefa (agent
 *     questions `answered` com dedupKey `duvida-dev:<repo>:<issue>:*` —
 *     `dedup-key-de-duvida.ts`). NÃO existe registro do raciocínio de RA/QA
 *     em si (`duvida-rails-mission.ts` é só chamada de modelo, sem
 *     persistência) — a única trilha durável é a resposta anterior do dono.
 *
 * Contrato central, MESMA disciplina do resto do produto ("configuração é
 * indício, teste é prova" + "nunca mascarar"): cada peça é injetada (mesmo
 * padrão de `ClienteDeQuadro`/`PrismaLike` em `garantir-sprint.ts`/
 * `agent-question.ts`) e NUNCA lança — uma fonte que falha vira uma frase em
 * `lacunas`, nunca um dado inventado nem uma exceção que derruba a pergunta
 * inteira (a pergunta TEM de nascer, mesmo incompleta).
 */

/** As 4 peças que compõem a história executiva de uma pergunta ao dono. */
export interface ContextoExecutivoDaPergunta {
  /** Título e período do ciclo corrente, ex.: "Sprint 4 (01/09 a 04/09)".
   *  `null` = não deu para determinar (ver `lacunas`). */
  ciclo: string | null
  /** O que a tarefa entrega, em uma frase (a seção "## Goal" da issue).
   *  `null` = não deu para ler (ver `lacunas`). */
  entrega: string | null
  /** O que o time (o próprio dono, em respostas anteriores) já decidiu
   *  sozinho sobre ESTA tarefa — uma frase por decisão, no máximo
   *  `MAXIMO_DE_DECISOES`. Lista vazia = nenhuma decisão anterior. */
  decisoes: string[]
  /** O que não pôde ser reunido, em português natural, para entrar no texto
   *  da pergunta em vez de um silêncio ou de um dado inventado. */
  lacunas: string[]
}

export const LACUNA_SEM_SPRINT_CONFIGURADA = 'este projeto ainda não tem uma sprint configurada'
export const LACUNA_SEM_CICLO_CORRENTE =
  'o ciclo configurado neste quadro não está em andamento hoje'
export const LACUNA_FALHA_AO_LER_CICLO =
  'não foi possível confirmar o ciclo configurado neste quadro'
export const LACUNA_SEM_OBJETIVO_LEGIVEL = 'não foi possível ler o objetivo desta tarefa'
export const LACUNA_SEM_DECISAO_REGISTRADA =
  'a equipe ainda não tinha registrado nenhuma decisão sobre esta tarefa'
export const LACUNA_FALHA_AO_LER_DECISOES =
  'não foi possível ler as decisões anteriores desta tarefa'

/**
 * Um contexto totalmente vazio — as 3 peças (ciclo/entrega/decisões) são
 * lacuna, nada inventado. Uso: quem escala uma dúvida sem ter (ou sem valer
 * a pena montar) acesso a quadro/issue/histórico — hoje só a reconciliação
 * histórica (`reconciliar-duvidas-escaladas.ts`, migração pontual das 24
 * sessões presas de 02/09, não o caminho vivo de escalada).
 */
export function contextoExecutivoVazio(): ContextoExecutivoDaPergunta {
  return {
    ciclo: null,
    entrega: null,
    decisoes: [],
    lacunas: [
      LACUNA_SEM_SPRINT_CONFIGURADA,
      LACUNA_SEM_OBJETIVO_LEGIVEL,
      LACUNA_SEM_DECISAO_REGISTRADA,
    ],
  }
}

/** Só o que este módulo usa do `ClienteDeQuadro` (garantir-sprint.ts) —
 *  permite injetar um fake nos testes, mesmo padrão do resto do produto. */
export interface ClienteDeQuadroParaContexto {
  getIterationField(input: {
    projectId: string
    fieldName: string
  }): Promise<{ fieldId: string; iterations: Iteracao[] }>
}

/** Uma opção `{label, value}` da PRÓPRIA pergunta (`agent_question.options`,
 *  JSON) — mesmo formato que `telegram-bot.ts`/`retomar-sessao-com-
 *  resposta.ts` já usam para casar valor↔rótulo. */
export interface OpcaoDeAgentQuestionParaContexto {
  label: string
  value: string
}

export interface AgentQuestionAnteriorParaContexto {
  answer: string | null
  /** As opções da pergunta que gerou esta resposta (JSON — `unknown` porque
   *  o Prisma devolve `Json` sem tipo). Ausente/vazio = pergunta aberta,
   *  sem botões (o `answer` já É o texto humano, nada para converter). */
  options?: unknown
}

/** Só o que este módulo usa do Prisma — permite injetar um fake nos testes,
 *  nunca banco real (mesmo padrão de `agent-question.ts`/PrismaLike). */
export interface PrismaParaContextoExecutivo {
  agentQuestion: {
    findMany: (args: unknown) => Promise<AgentQuestionAnteriorParaContexto[]>
  }
}

export interface DepsDoContextoExecutivo {
  /** `undefined` = projeto sem quadro de GitHub Projects V2 vinculado (ou
   *  quem chama decidiu não buscar). */
  clienteDeQuadro?: ClienteDeQuadroParaContexto
  /** O node id do quadro (GitHub Projects V2) — exigido junto de
   *  `clienteDeQuadro` para o ciclo ser lido. */
  quadroId?: string
  /** Busca o corpo bruto da issue no GitHub. `null` = não deu para ler (sem
   *  credencial, issue apagada, etc.) — nunca lança por si (mas esta função
   *  trata mesmo que lance). */
  buscarCorpoDaIssue: () => Promise<string | null>
  prisma: PrismaParaContextoExecutivo
  /** Data base (YYYY-MM-DD) para achar o ciclo corrente. Padrão: hoje (UTC). */
  hoje?: string
  /** Nome do campo de iteração no quadro. Padrão: `CAMPO_DE_SPRINT` (garantir-sprint.ts). */
  nomeDoCampoDeSprint?: string
}

export interface ArgsDoContextoExecutivo {
  /** O projeto no NOSSO banco — escopa a busca de decisões anteriores. */
  projectId: string
  /** "dono/nome" do repositório no GitHub. */
  repository: string
  issueNumber: number
}

const TETO_DO_CICLO = 120
const TETO_DA_ENTREGA = 220
const TETO_DA_DECISAO = 180
const MAXIMO_DE_DECISOES = 3
const NOME_PADRAO_DO_CAMPO_DE_SPRINT = 'Sprint'

/** Uma leitura isolada devolve seu valor E a lacuna (ou `null`) no MESMO
 *  objeto — nunca um array de lacunas compartilhado e mutado por 3 funções
 *  ao mesmo tempo (item 5, fix-up): rodar em paralelo com estado mutável
 *  compartilhado teria ordem de gravação não-determinística; devolvendo a
 *  lacuna junto do valor, quem combina os 3 resultados decide a ORDEM final
 *  (ciclo → entrega → decisões, sempre, disputa ou não a corrida). */
interface ResultadoDeLeitura<T> {
  valor: T
  lacuna: string | null
}

/**
 * Monta a história executiva de uma pergunta ao dono. NUNCA lança — cada
 * fonte roda ISOLADA e EM PARALELO (item 5, fix-up: ciclo, entrega e
 * decisões não dependem uma da outra — lidas em fila elas só somavam a
 * latência das 3; `Promise.all` é seguro aqui porque nenhuma das 3 funções
 * abaixo deixa uma exceção escapar do próprio `try/catch` — uma fonte
 * falhando nunca derruba `Promise.all` nem as outras 2).
 */
export async function montarContextoExecutivoDaPergunta(
  args: ArgsDoContextoExecutivo,
  deps: DepsDoContextoExecutivo
): Promise<ContextoExecutivoDaPergunta> {
  const [resultadoCiclo, resultadoEntrega, resultadoDecisoes] = await Promise.all([
    lerCicloCorrente(deps),
    lerEntrega(deps),
    lerDecisoesAnteriores(args, deps),
  ])

  const lacunas = [resultadoCiclo.lacuna, resultadoEntrega.lacuna, resultadoDecisoes.lacuna].filter(
    (lacuna): lacuna is string => lacuna !== null
  )

  return {
    ciclo: resultadoCiclo.valor,
    entrega: resultadoEntrega.valor,
    decisoes: resultadoDecisoes.valor,
    lacunas,
  }
}

async function lerCicloCorrente(
  deps: DepsDoContextoExecutivo
): Promise<ResultadoDeLeitura<string | null>> {
  if (!deps.clienteDeQuadro || !deps.quadroId) {
    return { valor: null, lacuna: LACUNA_SEM_SPRINT_CONFIGURADA }
  }
  try {
    const campo = await deps.clienteDeQuadro.getIterationField({
      projectId: deps.quadroId,
      fieldName: deps.nomeDoCampoDeSprint ?? NOME_PADRAO_DO_CAMPO_DE_SPRINT,
    })
    const hoje = deps.hoje ?? new Date().toISOString().slice(0, 10)
    const atual = sprintCorrente(campo.iterations, hoje)
    if (!atual) {
      return { valor: null, lacuna: LACUNA_SEM_CICLO_CORRENTE }
    }
    return {
      valor: sanitizar(`${atual.title} (${formatarPeriodo(atual)})`, TETO_DO_CICLO),
      lacuna: null,
    }
  } catch {
    // Rede, GraphQL, token sem autorização — nunca deixa a pergunta inteira
    // cair por causa do quadro estar inacessível.
    return { valor: null, lacuna: LACUNA_FALHA_AO_LER_CICLO }
  }
}

async function lerEntrega(
  deps: DepsDoContextoExecutivo
): Promise<ResultadoDeLeitura<string | null>> {
  try {
    const corpo = await deps.buscarCorpoDaIssue()
    const goal = lerSecaoDaIssue(corpo, 'Goal')
    if (!goal) {
      return { valor: null, lacuna: LACUNA_SEM_OBJETIVO_LEGIVEL }
    }
    return { valor: sanitizar(primeiraFrase(goal), TETO_DA_ENTREGA), lacuna: null }
  } catch {
    return { valor: null, lacuna: LACUNA_SEM_OBJETIVO_LEGIVEL }
  }
}

async function lerDecisoesAnteriores(
  args: ArgsDoContextoExecutivo,
  deps: DepsDoContextoExecutivo
): Promise<ResultadoDeLeitura<string[]>> {
  try {
    const prefixo = `${PREFIXO_DUVIDA_DEV}${args.repository}:${args.issueNumber}:`
    const anteriores = await deps.prisma.agentQuestion.findMany({
      where: { projectId: args.projectId, status: 'answered', dedupKey: { startsWith: prefixo } },
      orderBy: { createdAt: 'asc' },
    })
    const decisoes = anteriores
      .map((q) => converterValorEmDecisaoLegivel((q.answer ?? '').trim(), q.options))
      .filter((texto): texto is string => texto !== null && texto.length > 0)
      .slice(0, MAXIMO_DE_DECISOES)
      .map((texto) => sanitizar(texto, TETO_DA_DECISAO))
    if (decisoes.length === 0) {
      return { valor: decisoes, lacuna: LACUNA_SEM_DECISAO_REGISTRADA }
    }
    return { valor: decisoes, lacuna: null }
  } catch {
    // Banco fora do ar não pode derrubar a pergunta — a decisão anterior é
    // só UMA das 4 peças da história.
    return { valor: [], lacuna: LACUNA_FALHA_AO_LER_DECISOES }
  }
}

/** Um `value` que não bate com NENHUMA opção e parece um identificador
 *  interno (minúsculas/dígitos/hífen, sem espaço/acento/pontuação) — nunca
 *  o formato de uma frase livre do dono. */
const REGEX_PARECE_VALOR_INTERNO = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

function opcoesValidas(options: unknown): OpcaoDeAgentQuestionParaContexto[] {
  if (!Array.isArray(options)) return []
  return options.filter((o): o is OpcaoDeAgentQuestionParaContexto => {
    if (typeof o !== 'object' || o === null) return false
    const candidato = o as { label?: unknown; value?: unknown }
    return typeof candidato.label === 'string' && typeof candidato.value === 'string'
  })
}

/**
 * Item 2 (fix-up): quando o dono decide clicando num botão, o que fica
 * gravado em `answer` é o VALUE interno (ex.: "seguir-suposicao-ra"), nunca
 * o label — mesmo defeito que `telegram-bot.ts`/`retomar-sessao-com-
 * resposta.ts` já resolvem casando valor↔rótulo pelas OPÇÕES DA PRÓPRIA
 * pergunta (`agent_question.options`).
 *
 * Diferença deliberada dos outros dois arquivos: eles caem de volta no
 * valor cru quando não acham o label (audiência técnica/espelho visual,
 * onde mostrar o value é aceitável). Aqui a promessa é NUNCA mostrar código
 * ao dono — então, sem rótulo correspondente, só mantém o texto como está
 * quando ele parece FRASE LIVRE (o dono escolheu "Outro" e escreveu com as
 * próprias palavras — isso já É texto humano, teria sentido apagar). Só
 * quando o valor sem rótulo AINDA parece um identificador interno (sem
 * espaço, minúsculas-com-hífen) é que omite — nunca arrisca mostrar código.
 */
function converterValorEmDecisaoLegivel(valorBruto: string, options: unknown): string | null {
  if (valorBruto.length === 0) return null
  const opcoes = opcoesValidas(options)
  if (opcoes.length === 0) return valorBruto // pergunta aberta: já é texto humano
  const encontrada = opcoes.find((o) => o.value === valorBruto)
  if (encontrada) return encontrada.label
  if (REGEX_PARECE_VALOR_INTERNO.test(valorBruto)) return null // código órfão: omite
  return valorBruto // frase livre (ex.: resposta "Outro"): mantém como está
}

/**
 * Item 3 (fix-up): objetivo da issue e decisão anterior são texto de
 * TERCEIRO (o modelo escreveu o corpo da issue; o dono escreveu a resposta
 * anterior) — só limpar caractere de controle não impede a palavra
 * proibida de atravessar ("o desenvolvedor valida o webhook" chegaria
 * intacto ao dono, quebrando a MESMA promessa de D72/D73 em
 * `texto-de-escalada.ts`: nunca "dev"/"desenvolvedor"/"técnica").
 *
 * Escolha de design: SUBSTITUI em vez de cortar/apagar a palavra — cortar
 * deixaria a frase truncada ("O valida o webhook...") ou sem sentido
 * gramatical. Cada regra troca pela MESMA classe gramatical, no MESMO
 * número (singular/plural) e com a MESMA capitalização do que foi
 * encontrado:
 *   - "dev"/"desenvolvedor" (+ variações de gênero/plural) → "responsável"/
 *     "responsáveis" — substantivo, invariante em gênero, então cobre
 *     "o desenvolvedor"/"a desenvolvedora"/"os desenvolvedores" sem
 *     precisar decidir gênero;
 *   - "técnica"/"técnico" (+ plurais) → "operacional"/"operacionais" —
 *     adjetivo em "-al", também invariante em gênero (só muda no plural),
 *     então serve tanto para "dúvida técnica" (fem.) quanto "detalhe
 *     técnico" (masc.) sem quebrar a concordância.
 */
interface RegraDePalavraProibida {
  regex: RegExp
  singular: string
  plural: string
  sufixosDePlural: readonly string[]
}

const REGRAS_DE_PALAVRA_PROIBIDA: readonly RegraDePalavraProibida[] = [
  {
    regex: /(?<![\p{L}\p{N}_])desenvolvedor(a|es|as)?(?![\p{L}\p{N}_])/giu,
    singular: 'responsável',
    plural: 'responsáveis',
    sufixosDePlural: ['es', 'as'],
  },
  {
    regex: /(?<![\p{L}\p{N}_])dev(s)?(?![\p{L}\p{N}_])/giu,
    singular: 'responsável',
    plural: 'responsáveis',
    sufixosDePlural: ['s'],
  },
  {
    regex: /(?<![\p{L}\p{N}_])técnic[ao](s)?(?![\p{L}\p{N}_])/giu,
    singular: 'operacional',
    plural: 'operacionais',
    sufixosDePlural: ['s'],
  },
]

function comMesmaCapitalizacao(original: string, substituto: string): string {
  const primeiraLetra = original.charAt(0)
  const ehMaiuscula =
    primeiraLetra !== '' &&
    primeiraLetra === primeiraLetra.toUpperCase() &&
    primeiraLetra !== primeiraLetra.toLowerCase()
  return ehMaiuscula ? substituto.charAt(0).toUpperCase() + substituto.slice(1) : substituto
}

function filtrarPalavrasProibidas(texto: string): string {
  return REGRAS_DE_PALAVRA_PROIBIDA.reduce(
    (acc, regra) =>
      acc.replace(regra.regex, (match: string, sufixo?: string) => {
        const substituto =
          sufixo && regra.sufixosDePlural.includes(sufixo) ? regra.plural : regra.singular
        return comMesmaCapitalizacao(match, substituto)
      }),
    texto
  )
}

/**
 * Item 4 (fix-up): conta e corta por CARACTERE INTEIRO (grafema), nunca por
 * unidade de código UTF-16 — `.length`/`.slice()` cortam um par substituto
 * (emoji fora do BMP) ao meio, deixando uma surrogate solta (glifo
 * quebrado) bem no ponto de corte.
 */
const SEGMENTADOR_DE_GRAFEMAS = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' })

function grafemasDe(texto: string): string[] {
  return Array.from(SEGMENTADOR_DE_GRAFEMAS.segment(texto), (s) => s.segment)
}

function cortarRespeitandoGrafemas(texto: string, teto: number): string {
  const grafemas = grafemasDe(texto)
  if (grafemas.length <= teto) return texto
  return `${grafemas
    .slice(0, Math.max(0, teto - 1))
    .join('')
    .trim()}…`
}

/**
 * Tira caracteres de controle (quebra de linha inclusive), colapsa espaço e
 * barra palavra proibida — texto de terceiro (corpo de issue escrito pelo
 * modelo, resposta anterior do dono) não pode quebrar o layout de uma
 * mensagem de uma frase por peça, nem carregar vocabulário proibido só
 * porque veio de fora. Corta no teto (por grafema, item 4) com reticências
 * em vez de estourar o tamanho da pergunta.
 */
function sanitizar(texto: string, teto: number): string {
  const regexDeControle = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g')
  const semControle = filtrarPalavrasProibidas(
    texto.replace(regexDeControle, ' ').replace(/\s+/g, ' ').trim()
  )
  return cortarRespeitandoGrafemas(semControle, teto)
}

/**
 * Item 1 (fix-up): a primeira frase de um texto livre. Corta na 1ª
 * pontuação de fim de frase (`.!?`) que REALMENTE termina uma frase — antes
 * cortava na 1ª ocorrência cega, quebrando no meio de número decimal
 * ("2.5%" virava "2."), versão ("v2.5.1"), sigla encadeada ("E.U.A.") ou
 * abreviação de endereço ("Av. Paulista").
 */
function primeiraFrase(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim()
  const intervalosDeSigla = acharIntervalosDeSiglaEncadeada(limpo)
  const regexPontuacaoDeFrase = /[.!?]/g
  let match: RegExpExecArray | null
  while ((match = regexPontuacaoDeFrase.exec(limpo))) {
    if (naoTerminaAFraseAqui(limpo, match.index, intervalosDeSigla)) continue
    return limpo.slice(0, match.index + 1).trim()
  }
  return limpo
}

// Palavras que, seguidas de ponto, quase nunca fecham a frase (abreviação de
// título/endereço) — lista pequena e deliberada, o objetivo é não cortar no
// meio de "Av. Paulista"/"Dr. Fulano", não reconhecer toda abreviação do
// português.
const ABREVIACOES_QUE_NAO_TERMINAM_FRASE = new Set([
  'av',
  'al',
  'r',
  'rod',
  'sr',
  'sra',
  'dr',
  'dra',
  'prof',
  'profa',
  'depto',
  'ltda',
  'etc',
  'vs',
  'gen',
  'cia',
  'cel',
  'eng',
  'no',
])

/** "E.U.A." — sigla encadeada: 2+ grupos de UMA letra maiúscula + ponto,
 *  colados (sem espaço). Acha o intervalo INTEIRO de uma vez (em vez de
 *  olhar só 1 ou 2 caracteres antes de cada ponto) para não perder o 1º
 *  ponto do grupo, que não tem outro "letra+ponto" antes dele — só depois. */
function acharIntervalosDeSiglaEncadeada(texto: string): Array<[number, number]> {
  const regex = /(?:[A-ZÀ-Ú]\.){2,}/gu
  const intervalos: Array<[number, number]> = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(texto))) {
    intervalos.push([m.index, m.index + m[0].length])
  }
  return intervalos
}

function dentroDeAlgumIntervalo(posicao: number, intervalos: Array<[number, number]>): boolean {
  return intervalos.some(([inicio, fim]) => posicao >= inicio && posicao < fim)
}

function ehAbreviacaoConhecida(texto: string, posicao: number): boolean {
  const antes = texto.slice(0, posicao)
  const palavra = antes.match(/\p{L}+$/u)?.[0]?.toLowerCase()
  return !!palavra && ABREVIACOES_QUE_NAO_TERMINAM_FRASE.has(palavra)
}

function naoTerminaAFraseAqui(
  texto: string,
  posicao: number,
  intervalosDeSigla: Array<[number, number]>
): boolean {
  const anterior = texto.charAt(posicao - 1)
  const seguinte = texto.charAt(posicao + 1)
  // decimal/versão: ponto colado entre dois dígitos ("2.5", "4.2.1")
  if (/\d/.test(anterior) && /\d/.test(seguinte)) return true
  if (dentroDeAlgumIntervalo(posicao, intervalosDeSigla)) return true
  if (ehAbreviacaoConhecida(texto, posicao)) return true
  return false
}

function formatarPeriodo(it: Iteracao): string {
  const inicio = new Date(`${it.startDate}T00:00:00Z`)
  const fim = new Date(inicio.getTime() + it.duration * 86400000)
  return `${formatarData(inicio)} a ${formatarData(fim)}`
}

function formatarData(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(d)
}
